'use strict';
// Весь бэкенд магазина в одном процессе: статика + JSON API + телеграм-бот.
// Зависимостей нет вообще — нужен только Node 18+.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Мини-загрузчик .env — чтобы `node server/index.js` работал и без systemd,
// который в проде подставляет переменные сам через EnvironmentFile.
require('./env').loadEnv();

const authguard = require('./authguard');
const { createTenant } = require('./tenant');
const { createBackupManager } = require('./backup');
const { createSiteSync } = require('./sitesync');
const { sanitize, mergeDeep } = require('./settings');
const { esc, createTelegram } = require('./telegram');
const { encryptSecret } = require('./secrets');
// Разовый клиент Bot API под конкретный токен — нужен, чтобы проверить
// присланный продавцом токен до того, как он попадёт в базу.
const createTenantTelegram = token => createTelegram({ botToken: token, apiBase: process.env.TELEGRAM_API_BASE });
const payments = require('./payments');
// Правила оформления заказа — общие для мини-аппа и кнопочного бота в чате
const { money, applyPromo, placeOrder, createPaymentLink } = require('./checkout');
const { resolveTheme, onAccentColor } = require('../public/theme-core.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 8 * 1024 * 1024; // хватает на dataURL-картинку до ~6 МБ

// Кому из Telegram открыта админка: chat_id владельцев через запятую.
// Пусто — входа из бота нет, остаётся только ADMIN_TOKEN.
const ADMIN_CHAT_IDS = String(process.env.ADMIN_CHAT_IDS || '')
  .split(',').map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n) && n !== 0);

// Режим платформы: один процесс обслуживает много магазинов, каждый — на
// своём поддомене, реестр и секреты в MySQL (схема из Stage 2). Без
// MULTITENANT=1 всё работает по-файловому, ровно как раньше.
const MULTI = String(process.env.MULTITENANT || '').trim() === '1';
const MULTI_DOMAIN = String(process.env.MULTITENANT_DOMAIN || '').toLowerCase().trim();
const MULTI_ROOT = process.env.MULTITENANT_DATA_ROOT || path.join(process.cwd(), 'data', 'shops');
const SECRET_KEY = process.env.SECRET_KEY || '';
// Общий ключ с сайтом магазина: по нему сайт присылает боту заявки с формы.
// Пусто — приём заявок выключен (эндпоинт отвечает 404).
const SITE_LEAD_TOKEN = String(process.env.SITE_LEAD_TOKEN || '').trim();
// Сайт магазина (https), если витрина живёт там: тогда «Открыть магазин» и
// кнопка меню открывают сайт, «Открыть панель» — его админку, а свой каталог
// бота в чате не показывается — витрина одна.
const SITE_URL = /^https:\/\/[^\s/]+/i.test(String(process.env.SITE_URL || '').trim())
  ? String(process.env.SITE_URL).trim().replace(/\/+$/, '') : '';

if (!MULTI && !ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN не задан в .env — админка была бы открыта всем. Выхожу.');
  process.exit(1);
}
if (MULTI) {
  const problems = [];
  const dbc = require('./db').dbConfigFromEnv();
  if (!dbc.host || !dbc.database) problems.push('MYSQL_HOST/MYSQL_DATABASE');
  if (!MULTI_DOMAIN) problems.push('MULTITENANT_DOMAIN');
  if (SECRET_KEY.length < 12) problems.push('SECRET_KEY (от 12 символов)');
  if (problems.length) {
    console.error(`MULTITENANT=1 требует: ${problems.join(', ')}. Выхожу.`);
    process.exit(1);
  }
}

// ---------- арендаторы ----------
// Файловый режим: арендатор ровно один и собирается из окружения, как прежде.
// Режим платформы: магазины берутся из реестра (MySQL), а запрос выбирает
// себе арендатора по поддомену (als.run в createServer ниже). Обработчики
// разницы не видят: короткие имена резолвятся в текущего арендатора.
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();

let solo = null;
if (!MULTI) {
  solo = createTenant({
    id: process.env.SHOP_ID || '',
    dataDir: process.env.DATA_DIR,
    botToken: process.env.BOT_TOKEN,
    adminToken: ADMIN_TOKEN,
    publicUrl: process.env.PUBLIC_URL,
    apiBase: process.env.TELEGRAM_API_BASE,
    botMode: process.env.BOT_MODE,
    // Одиночная установка тоже может стоять на вебхуке (install.sh ставит
    // BOT_STRICT_WEBHOOK=1 вместе с HTTPS) — запрет отката читаем и здесь.
    strictWebhook: String(process.env.BOT_STRICT_WEBHOOK || '') === '1',
    adminChatIds: ADMIN_CHAT_IDS,
    siteUrl: SITE_URL,
  });

  // Резервные копии папки данных: снимки по расписанию и вручную из админки.
  // BACKUP_DIR не задан — копии ложатся в backups/ рядом с папкой данных.
  solo.backup = createBackupManager({
    dataDir: solo.store.DATA_DIR,
    backupsRoot: process.env.BACKUP_DIR,
    tenantId: solo.id || 'shop',
    store: solo.store,
  });

  // Витрина — сайт магазина: товары кнопочного каталога в чате приходят с
  // него, а заказы из корзины отправляются туда же в «Заявки».
  if (SITE_URL && SITE_LEAD_TOKEN) {
    // SITE_API_URL — внутренний адрес сайта на том же сервере (http://127.0.0.1:…),
    // чтобы не ходить к себе через интернет; нет — тот же SITE_URL
    const apiUrl = /^https?:\/\/[^\s/]+/i.test(String(process.env.SITE_API_URL || '').trim()) ? String(process.env.SITE_API_URL).trim() : SITE_URL;
    solo.siteSync = createSiteSync(solo, { siteUrl: SITE_URL, apiUrl, token: SITE_LEAD_TOKEN });
    solo.onOrder = order => solo.siteSync.pushOrder(order);
    solo.siteSync.start();
  }
}

function currentTenant() {
  const s = als.getStore();
  return (s && s.tenant) || solo;
}

// Короткие имена — теперь прокси к текущему арендатору запроса. Все фабрики
// (store/orders/bot/telegram/backup) собраны замыканиями без this, так что
// прокидка вызовов через прокси безопасна, а у обработчиков не меняется ни строки.
const liveOf = key => new Proxy({}, {
  get(_t, prop) {
    const t = currentTenant();
    const owner = t && t[key];
    const v = owner ? owner[prop] : undefined;
    return typeof v === 'function' ? v.bind(owner) : v;
  },
});
const store = liveOf('store');
const ordersRepo = liveOf('orders');
const bot = liveOf('bot');
const backup = liveOf('backup');
const tg = liveOf('telegram');
const tgApi = (...a) => currentTenant().telegram.tgApi(...a);
const validateInitData = (...a) => currentTenant().telegram.validateInitData(...a);

// ---------- утилиты ----------
const TEXTUAL = new Set(['.html', '.js', '.css', '.json', '.svg']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Без явного заголовка ответ без даты и валидатора можно кэшировать
    // «эвристически» — так делают и браузеры, и промежуточные прокси, и особенно
    // охотно вебвью Telegram. В результате продавец менял настройки, а клиент
    // продолжал получать старый /api/settings. Данные магазина живые, кэшировать
    // их нельзя вообще.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// Сравнение токена без утечки времени — дайджест арендатора считается один раз
// при его создании (см. tenant.js), здесь только сверка.
function tokenOk(req, given = String(req.headers['x-admin-token'] || '')) {
  const hash = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(hash, currentTenant().adminHash);
}

// Админка из Telegram выдаёт билеты вместо вечного пароля: подпись на
// ключе арендатора (sessionKey) + срок жизни. Таблицы сессий нет — отзыв
// происходит сам: билет протух, владелец выпал из списка допуска.
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function issueAdminSession(userId) {
  const exp = Date.now() + ADMIN_SESSION_TTL_MS;
  const payload = `a1.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', currentTenant().sessionKey).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function adminSessionOk(raw) {
  const m = /^a1\.(-?\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(String(raw || ''));
  if (!m) return false;
  const [, uid, exp, sig] = m;
  if (Number(exp) < Date.now()) return false;
  // выпавших из списка допуска не пускаем даже с живой подписью
  if (!currentTenant().isOwner(uid)) return false;
  const expected = crypto.createHmac('sha256', currentTenant().sessionKey).update(`a1.${uid}.${exp}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// простейший rate limit по IP — чтобы форму заказа нельзя было залить спамом
const hits = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n += 1;
  return rec.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 600000) hits.delete(k); }, 600000).unref();

const getSettings = () => currentTenant().settings();

// ---------- состояние VPS (карточка «Сервер» в админке) ----------
// Всё читается из ядра/proc без внешних зависимостей; «тяжёлые» вызовы
// (df, nvidia-smi) кэшируются на минуту, а общий ответ — на 30 секунд,
// так что даже частые обновления из админки серверу почти ничего не стоят.
const SYS_TTL_MS = 30 * 1000;
const SLOW_TTL_MS = 60 * 1000;

let sysCache = { at: 0, data: null };
let diskCache = { at: 0, done: false, value: null };
let gpuCache = { at: 0, value: null };
let gpuAbsent = false;
let cpuPrev = { at: 0, total: 0, idle: 0 };
let cpuLast = 0;

function cpuTotals() {
  let total = 0, idle = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { at: Date.now(), total, idle };
}

// Процент загрузки CPU — дельта между двумя снимками os.cpus(). Первый
// снимок берём при старте процесса, чтобы уже первый запрос показывал
// реальную загрузку, а не ноль.
cpuPrev = cpuTotals();
function cpuPercent() {
  const cur = cpuTotals();
  if (cur.at - cpuPrev.at >= 2000) {
    const dt = cur.total - cpuPrev.total;
    const di = cur.idle - cpuPrev.idle;
    if (dt > 0) cpuLast = Math.round(100 * (1 - di / dt));
    cpuPrev = cur;
  }
  return cpuLast;
}

// os.freemem() отдаёт «чистый» MemFree, без кэш-буферов ядра, и память
// выглядела бы занятой почти целиком. MemAvailable из /proc/meminfo —
// честная цифра: сколько реально можно выделить.
function memInfo() {
  const total = os.totalmem();
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(raw);
    if (m) return { total, free: Number(m[1]) * 1024 };
  } catch (e) { /* не Linux — fallback ниже */ }
  return { total, free: os.freemem() };
}

function diskInfo() {
  return new Promise(resolve => {
    if (process.platform !== 'linux') return resolve(null);
    execFile('df', ['-Pk', '/'], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(null);
      const parts = (String(out).split('\n')[1] || '').trim().split(/\s+/);
      const total = Number(parts[1]) * 1024;
      const free = Number(parts[3]) * 1024;
      if (!total || Number.isNaN(free)) return resolve(null);
      resolve({ total, used: total - free });
    });
  });
}

function gpuInfo() {
  return new Promise(resolve => {
    execFile('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 4000 }, (err, out) => {
      if (err) { gpuAbsent = true; return resolve(null); }
      const parts = (String(out).split('\n')[0] || '').split(',').map(x => x.trim());
      if (parts.length < 5 || parts[0] === '[N/A]') { gpuAbsent = true; return resolve(null); }
      resolve({
        name: parts[0],
        util: Number(parts[1]) || 0,
        memUsed: (Number(parts[2]) || 0) * 1048576,
        memTotal: (Number(parts[3]) || 0) * 1048576,
        temp: Number(parts[4]) || 0,
      });
    });
  });
}

async function systemStatus() {
  const now = Date.now();
  if (sysCache.data && now - sysCache.at < SYS_TTL_MS) return sysCache.data;

  const mem = memInfo();
  if (!diskCache.done || now - diskCache.at > SLOW_TTL_MS) {
    diskCache = { at: now, done: true, value: await diskInfo() };
  }
  // GPU без драйвера nvidia: опрашиваем один раз и запоминаем, что его нет,
  // чтобы не дёргать отсутствующую утилиту на каждый запрос.
  if (!gpuAbsent && now - gpuCache.at > SLOW_TTL_MS) {
    gpuCache = { at: now, value: await gpuInfo() };
  }

  const data = {
    platform: process.platform,
    hostUptime: Math.floor(os.uptime()),
    processUptime: Math.floor(process.uptime()),
    cores: os.cpus().length,
    cpu: cpuPercent(),
    load: os.loadavg().map(x => Number(x.toFixed(2))),
    mem: { total: mem.total, used: mem.total - mem.free },
    rss: process.memoryUsage().rss,
    disk: diskCache.value,
    gpu: gpuCache.value,
  };
  sysCache = { at: now, data };
  return data;
}

// Короткий отпечаток текущих настроек — им помечается отдаваемый index.html,
// чтобы кэш клиента протухал ровно тогда, когда продавец что-то поменял.
// Хэш содержимого (а не номер версии), чтобы ETag переживал перезапуск; но
// пересчитывается он только после записи настроек, а не на каждый запрос.
// Кэш свой у каждого магазина: в режиме платформы их в процессе много.
const fpCache = new WeakMap(); // арендатор → { v, fp }
function settingsFingerprint() {
  const t = currentTenant();
  const v = t.store.version ? t.store.version('settings') : null;
  const hit = fpCache.get(t);
  if (v !== null && hit && hit.v === v) return hit.fp;
  const fp = crypto.createHash('sha1').update(JSON.stringify(t.store.read('settings', {}))).digest('hex').slice(0, 10);
  if (v !== null) fpCache.set(t, { v, fp });
  return fp;
}

// ---------- сжатие и кэш ответов ----------
// gzip и brotli идут через пул потоков zlib, а не синхронно: главный поток
// в это время обслуживает остальных. Результат кэшируется, поэтому сжатие
// случается один раз на версию файла или данных, а не на каждый запрос.
const { promisify } = require('node:util');
const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return '';
}

// entry — { raw: Buffer }; сжатые варианты дописываются в него лениво.
// Промис кладётся сразу: параллельные первые запросы ждут одно сжатие.
function encodedBody(entry, enc) {
  if (!enc) return Promise.resolve(entry.raw);
  if (!entry[enc]) {
    entry[enc] = (enc === 'br'
      ? brotliAsync(entry.raw, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.raw.length,
      } })
      : gzipAsync(entry.raw, { level: 9 })
    ).catch(e => { console.error('[compress]', enc, e.message); entry[enc] = null; return null; });
  }
  return entry[enc].then(buf => buf || entry.raw);
}

// Готовые тексты статики: ключ — путь, размер, mtime и (для index.html)
// отпечаток настроек. Потолок по числу записей: в режиме платформы у
// каждого магазина своя витрина, и старые версии не должны копиться.
const STATIC_CACHE_MAX = 64;
const staticCache = new Map();

function staticEntry(key, build) {
  let entry = staticCache.get(key);
  if (entry) return entry;
  entry = { raw: null, ready: Promise.resolve().then(build).then(buf => { entry.raw = buf; return entry; }) };
  entry.ready.catch(() => staticCache.delete(key));
  staticCache.set(key, entry);
  if (staticCache.size > STATIC_CACHE_MAX) staticCache.delete(staticCache.keys().next().value);
  return entry;
}

// JSON публичного API, сжатый и закэшированный по версии данных. Заголовки
// те же, что у json(): no-store — данные живые, кэшировать их клиенту нельзя.
const apiCache = new WeakMap(); // арендатор → Map(ключ → { v, raw, gzip, br })
async function sendCachedJson(req, res, key, v, build) {
  const t = currentTenant();
  let m = apiCache.get(t);
  if (!m) apiCache.set(t, (m = new Map()));
  let entry = m.get(key);
  if (!entry || entry.v !== v) {
    entry = { v, raw: Buffer.from(JSON.stringify(build()), 'utf8') };
    m.set(key, entry);
  }
  // мелкий ответ сжимать дороже, чем отдать как есть
  const enc = entry.raw.length > 1024 ? pickEncoding(req) : '';
  const body = await encodedBody(entry, enc);
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (enc && body !== entry.raw) h['Content-Encoding'] = enc;
  res.writeHead(200, h);
  res.end(body);
}

const versionOf = key => (store.version ? store.version(key) : String(Date.now()));

// На витрину не отдаём то, что клиенту знать незачем. Особенно creds платёжного
// мерчанта: /api/settings открыт всем без авторизации, и утечь секрет там нельзя.
function publicSettings(s) {
  const { notify, payments, promo, ...rest } = s;
  return {
    ...rest,
    notifyEnabled: notify.enabled,
    // Сами коды наружу не отдаём — иначе их можно было бы просто прочитать
    // в /api/settings и раздать. Клиент только знает, что поле надо показать,
    // а проверка кода идёт отдельным запросом на сервер.
    promo: { enabled: promo.enabled, label: promo.label },
    payments: {
      enabled: payments.enabled,
      required: payments.required,
      buttonText: payments.buttonText,
      successText: payments.successText,
    },
  };
}

// Анонс подписчикам бота: новинка или смена цены. Стреляем fire-and-forget —
// ответ админке не должен зависеть от скорости рассылки по сотням чатов,
// а сбой доставки не должен ломать сохранение товара.
function announceProduct(s, product, kind, oldPrice) {
  if (!s.announce || !s.announce.enabled) return;
  const shop = esc(s.brand.shopName);
  let text;
  if (kind === 'price') {
    text = `💪 <b>${shop}</b> — изменилась цена\n\n<b>${esc(product.name)}</b> — теперь ${money(product.price, s)}` +
      (oldPrice != null ? ` (было ${money(oldPrice, s)})` : '');
  } else {
    text = `🆕 <b>${shop}</b> — новинка!\n\n<b>${esc(product.name)}</b>` +
      (s.commerce.priceHidden ? '' : ` — ${money(product.price, s)}`);
  }
  bot.sendToSubscribers(text, 'анонс', s).catch(e => console.error('[announce]', e.message));
}

// ---------- статика ----------
// Тема, зашитая прямо в HTML. Клиент получает готовые CSS-переменные в первом
// же байте ответа и рисует правильную палитру сразу — без «дефолтная тёмная,
// а через секунду нужная». Кэш в localStorage от этого не спасал: он пуст при
// первом заходе, а Telegram чистит хранилище webview довольно охотно.
const FONT_STACKS_SRV = {
  'Oswald': "'Oswald',sans-serif",
  'Archivo Black': "'Archivo Black',sans-serif",
  'Inter': "'Inter',-apple-system,sans-serif",
  'Space Grotesk': "'Space Grotesk',sans-serif",
  'system': "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
};
const DENSITY_SRV = { compact: 0.8, normal: 1, roomy: 1.25 };

function bootThemeCSS(s) {
  const r = resolveTheme(s.theme);
  const ratio = s.theme.imageRatio === 'square' ? '1/1' : s.theme.imageRatio === 'portrait' ? '3/4' : '4/3';
  const vars = [
    `--bg:${r.bg}`, `--surface:${r.surface}`, `--surface-2:${r.surface2}`,
    `--text:${r.text}`, `--muted:${r.muted}`, `--accent:${r.accent}`,
    `--accent-2:${r.accent2}`, `--heart:${r.accent}`,
    `--on-accent:${onAccentColor(r.accent) || '#ffffff'}`,
    `--radius:${r.radius}px`, `--bw:${r.borderWidth}px`,
    `--fs:${(r.fontScale / 100).toFixed(2)}`,
    `--gap:${(DENSITY_SRV[r.density] || 1).toFixed(2)}`,
    `--caps:${r.uppercase ? 'uppercase' : 'none'}`,
    `--font-display:${FONT_STACKS_SRV[r.fontDisplay] || FONT_STACKS_SRV.system}`,
    `--cols:${s.theme.gridColumns}`, `--ratio:${ratio}`,
  ].join(';');
  const cls = [r.glass && 'glass', s.theme.grain && 'grain', s.theme.diagonal && 'diagonal',
    s.theme.animations === 'off' && 'anim-off',
    s.theme.animations === 'reduced' && 'anim-reduced'].filter(Boolean).join(' ');
  // В режиме «подстроиться под тему Telegram» сервер не знает цветов клиента —
  // помечаем это через bootScheme, и первый кадр дорисует клиент из themeParams.
  const bootScript = `document.documentElement.dataset.bootClass=${JSON.stringify(cls)};` +
    (s.theme.colorScheme === 'telegram' ? "document.documentElement.dataset.bootScheme='telegram';" : '');
  return `<style id="bootTheme">:root{${vars}}</style>` +
    `<script>${bootScript}</script>`;
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  // Админка живёт в боте, но саму страницу не прячем: она лишь форма входа и
  // никаких секретов не содержит, вся настоящая защита — на API (токен +
  // authguard). Раньше аварийный вход шёл через ?token=<ADMIN_TOKEN> в адресе,
  // но query-строки оседают в access-логах nginx и истории браузера. Теперь
  // токен вводится только в поле формы и в URL не попадает никогда.
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(full).toLowerCase();
    // HTML и JS обязаны проверяться на свежесть при каждом заходе. Раньше html
    // шёл no-cache, а shared.js — на час: после обновления клиент час крутил
    // старый скрипт поверх новой разметки и падал на несуществующих функциях.
    // no-cache не значит «качать заново» — это условный запрос, при совпадении
    // ETag сервер отвечает 304 и тело не передаётся.
    const cacheControl = (ext === '.html' || ext === '.js' || ext === '.css')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable'; // картинки лежат под уникальными именами
    // ETag из размера и времени изменения: при no-cache браузер пришлёт
    // If-None-Match, и мы ответим 304 вместо повторной отдачи файла.
    //
    // Для index.html этого МАЛО. В него подставляется тема, а сам файл при смене
    // настроек не меняется — размер и mtime те же. Из-за этого продавец менял
    // оформление, а у покупателей оно не появлялось: их браузер слал
    // If-None-Match, получал 304 и продолжал показывать старую тему, пока не
    // почистит кэш. Поэтому подмешиваем в ETag отпечаток настроек: файл прежний,
    // но настройки другие — значит, ответ считается изменившимся.
    let etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`;
    const isIndex = rel === '/index.html';
    if (isIndex) etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}-${settingsFingerprint()}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      return res.end();
    }

    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: etag };

    // Тексты (index.html со стилями и скриптом — это ~150 КБ, плюс общие
    // скрипты) отдаём из памяти, уже сжатыми. Раньше index.html на каждый
    // заход читался с диска и жался gzipSync прямо в главном потоке — ~8 мс
    // CPU, в которые сервер не обслуживал никого. Теперь сборка и сжатие
    // случаются один раз на версию файла и настроек; ключ кэша — тот же ETag.
    // Картинки и шрифты не трогаем — они уже сжаты.
    if (isIndex || TEXTUAL.has(ext)) {
      const entry = await staticEntry(`${full}|${etag}`, async () => {
        if (!isIndex) return fsp.readFile(full);
        const s = getSettings();
        let html = await fsp.readFile(full, 'utf8');
        // Название магазина подставляем в разметку, а не только скриптом: иначе
        // и вкладка браузера, и шапка мини-аппа секунду показывают заглушку
        // «SHOP», прежде чем приедет /api/settings.
        html = html.replace('<title>SHOP</title>', `<title>${esc(s.brand.shopName)}</title>`);
        html = html.replace('</head>', bootThemeCSS(s) + '</head>');
        return Buffer.from(html, 'utf8');
      }).ready;
      const enc = pickEncoding(req);
      const body = await encodedBody(entry, enc);
      if (enc && body !== entry.raw) headers['Content-Encoding'] = enc;
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      return res.end(body);
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // ===== публичное =====
  // Оба ответа собираются и сжимаются один раз на версию данных: витрина
  // запрашивает их при каждом открытии мини-аппа.
  if (p === '/api/settings' && method === 'GET') {
    // имя бота узнаётся после getMe на старте — оно тоже часть версии ответа
    const botUsername = currentTenant().botUsername || '';
    return sendCachedJson(req, res, 'settings', `${versionOf('settings')}|${botUsername}`,
      () => ({ ...publicSettings(getSettings()), botUsername }));
  }

  if (p === '/api/products' && method === 'GET') {
    // от настроек зависит hideSoldOut, поэтому версия — по обоим документам
    return sendCachedJson(req, res, 'products', `${versionOf('products')}|${versionOf('settings')}`, () => {
      const s = getSettings();
      // Скрытые товары не отдаём вообще. Раньше их прятала только витрина, а сам
      // список был публичным: название и цену неопубликованного товара можно было
      // прочитать в /api/products, да и заказать его тоже.
      let list = store.read('products', []).filter(x => !x.hidden);
      if (s.catalog.hideSoldOut) list = list.filter(x => x.stock !== 0);
      return list;
    });
  }

  if (p === '/api/image' && method === 'GET') {
    const file = store.imagePath(url.searchParams.get('id'));
    if (!file) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const stat = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': stat.size,
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/avatar' && method === 'GET') {
    const user = validateInitData(url.searchParams.get('initData') || '');
    if (!user) { res.writeHead(401); return res.end('invalid initData'); }
    const photos = await tgApi('getUserProfilePhotos', { user_id: user.id, limit: 1 });
    const fileId = photos && photos.result && photos.result.photos && photos.result.photos[0] && photos.result.photos[0][0] && photos.result.photos[0][0].file_id;
    if (!fileId) { res.writeHead(404); return res.end('no photo'); }
    const file = await tgApi('getFile', { file_id: fileId });
    const fp = file && file.result && file.result.file_path;
    if (!fp) { res.writeHead(404); return res.end('no file'); }
    const img = await fetch(`https://api.telegram.org/file/bot${tg.BOT_TOKEN}/${fp}`);
    const buf = Buffer.from(await img.arrayBuffer());
    res.writeHead(200, { 'Content-Type': img.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    return res.end(buf);
  }

  // Приём апдейтов, когда включён BOT_MODE=webhook. Без сверки секрета этот
  // адрес был бы открытым приёмником: любой мог бы прислать поддельное сообщение
  // «от клиента» и дёрнуть менеджера. Секрет Telegram кладёт в заголовок сам.
  if (p === '/api/webhook' && method === 'POST') {
    const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const expected = bot.webhookSecret();
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      // 401 без тела: Telegram повторит запрос, но чужой не поймёт, что не так
      res.writeHead(401); return res.end();
    }
    let update;
    try { update = await readBody(req); } catch (e) { res.writeHead(200); return res.end('ok'); }
    // Приостановленный магазин апдейты принимает, но не обрабатывает: отвечать
    // отказом нельзя (Telegram будет ретраить сутками), а обслуживать клиентов
    // магазина, за который не заплачено, — тем более.
    if (MULTI && currentTenant().status !== 'active') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    // Отвечаем 200 сразу, обработку делаем следом: если ответить не-2XX или
    // затянуть, Telegram будет слать тот же апдейт повторно.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    bot.handleUpdate(update).catch(e => console.error('[webhook] update failed:', e.message));
    return;
  }

  if (p === '/api/track-view' && method === 'POST') {
    try {
      const body = await readBody(req);
      const id = String(Number(body.id));
      if (id !== 'NaN') {
        const views = store.read('views', {});
        views[id] = (views[id] || 0) + 1;
        store.write('views', views);
      }
    } catch (e) { /* счётчик не критичен */ }
    return json(res, 200, { ok: true });
  }

  // Проверка промокода до оформления — чтобы покупатель сразу видел новую сумму
  if (p === '/api/promo/check' && method === 'POST') {
    if (!rateLimit('promo:' + ip, 20, 60000)) return json(res, 429, { error: 'Слишком много попыток, подождите минуту' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }

    const s = getSettings();
    const products = store.read('products', []);
    // сумму считаем сами по корзине из запроса, но по ценам из базы
    const total = (body.items || []).reduce((sum, i) => {
      const prod = products.find(x => x.id === Number(i.id) && !x.hidden);
      return sum + (prod ? prod.price * Math.max(1, Math.min(999, Number(i.qty) || 1)) : 0);
    }, 0);

    const r = applyPromo(s, body.code, total);
    if (!r.ok) return json(res, 200, { ok: false, error: r.error });
    return json(res, 200, { ok: true, code: r.code, discount: r.discount, total: r.total, label: r.label });
  }

  if (p === '/api/checkout' && method === 'POST') {
    if (!rateLimit(ip, 10, 60000)) return json(res, 429, { error: 'слишком много запросов, подождите минуту' });
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

    const s = getSettings();
    // Магазин на паузе. Витрина в этом режиме показывает заглушку вместо
    // каталога, но POST мимо неё проходил — и «закрытый» магазин продолжал
    // копить заказы, о которых продавец не знал.
    if (s.advanced.maintenanceMode) return json(res, 503, { error: s.advanced.maintenanceText });

    const tgUser = validateInitData(body.initData || '');
    // initData прислали, но подпись не сошлась — это подделка, а не «открыли в браузере».
    // Пустой initData по-прежнему значит «вне Telegram» и помечается гостем.
    if (!tgUser && body.initData) return json(res, 403, { error: 'invalid initData' });

    // Остатки, минимальная сумма, промокод, обязательный телефон, сохранение
    // и уведомление менеджеру — в checkout.js: по тем же правилам оформляет
    // заказы и кнопочный магазин в чате бота.
    const placed = await placeOrder(currentTenant(), {
      items: body.items, customer: body.customer, tgUser, promoCode: body.promoCode,
    });
    if (!placed.ok) return json(res, placed.status, { error: placed.error });
    const { order, finalTotal } = placed;

    // копия покупателю в чат с ботом
    if (s.bot.notifyCustomer && tgUser) {
      // Покупателю — только подтверждение и статус: переменную {order}
      // (служебная выгрузка для менеджера) из шаблона вырезаем — она могла
      // остаться в старых настройках. {name} оставляем.
      // LF собираем через fromCharCode, переносы схлопываем без regex-эскейпов
      const LF = String.fromCharCode(10);
      const receiptTpl = String(s.bot.customerReceiptText || '')
        .split('{order}').join('')
        .split(LF + LF + LF).join(LF + LF)
        .split(LF + LF + LF).join(LF + LF)
        .trim();
      const payload = {
        chat_id: tgUser.id,
        // {id} и {total} — номер и сумма именно этого заказа; {order}
        // (менеджерская выгрузка) выше вырезан из шаблона намеренно.
        text: bot.fill(receiptTpl, {
          name: esc(tgUser.first_name || ''),
          id: String(order.id),
          total: money(finalTotal, s),
        }),
        parse_mode: 'HTML',
      };
      // Кнопка открытия магазина в чеке — строго web_app (приватный чат,
      // значит условие Bot API соблюдено). url-кнопка здесь и была причиной
      // «магазин открывается огромным окном браузера» без обвязки Mini App.
      const appUrl = bot.shopWebAppUrl(s);
      if (appUrl) payload.reply_markup = { inline_keyboard: [[{ text: s.bot.buttonText, web_app: { url: appUrl } }]] };
      // Если web_app-кнопка отклоняется (домен не привязан в BotFather),
      // sendWithFallback сам повторит без неё и залогировает причину.
      const receipt = await bot.sendWithFallback(payload, `чек покупателю ${tgUser.id}`).catch(() => null);
      if (!receipt || !receipt.ok) {
        const why = (receipt && receipt.description) || 'нет связи с Telegram API';
        if (/blocked|forbidden|user is deactivated/i.test(why)) {
          // Самая частая причина: бот не может первым написать пользователю,
          // который ни разу не нажал /start (мини-апп открыт ссылкой, не чатом)
          console.warn(`[checkout] подтверждение покупателю ${tgUser.id} не доставлено: ${why} — покупатель не запускал бота или заблокировал его`);
        } else {
          console.error(`[checkout] подтверждение покупателю ${tgUser.id} не доставлено: ${why}`);
        }
      }
    }

    // total — пересчитанная сервером сумма (с промокодом): экран успеха
    // показывает именно её, а не сумму, насчитанную клиентом.
    return json(res, 200, { ok: true, orderId: order.id, total: finalTotal, orderText: placed.text.replace(/<[^>]+>/g, '') });
  }

  // Создание платежа по уже оформленному заказу. Сумму берём из сохранённого
  // заказа, а не из запроса — иначе её можно было бы занизить до рубля.
  if (p === '/api/pay' && method === 'POST') {
    if (!rateLimit(ip, 10, 60000)) return json(res, 429, { error: 'слишком много запросов' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }

    // Сумма, провайдер и ключ возврата — в checkout.js (оттуда же платит чат-бот)
    const r = await createPaymentLink(currentTenant(), body.orderId);
    if (!r.ok) return json(res, r.status, { error: r.error });
    return json(res, 200, { ok: true, url: r.url, manual: r.manual });
  }

  // Статус оплаты для экрана возврата. Раньше витрина верила адресной строке:
  // «?paid=123» рисовало «Оплата получена», хотя денег могло не быть — платёж
  // подтверждается колбэком мерчанта, а не редиректом браузера. Отдаём только
  // факт оплаты и ничего о покупателе, и только по ключу из самого заказа.
  if (p === '/api/pay/status' && method === 'GET') {
    if (!rateLimit('paystatus:' + ip, 60, 60000)) return json(res, 429, { error: 'слишком много запросов' });
    const order = ordersRepo.find(url.searchParams.get('id'));
    const given = String(url.searchParams.get('t') || '');
    const expected = String(order && order.returnToken || '');
    // Сравнение по дайджестам: длина ключа наружу тоже не утекает, а
    // несуществующий заказ и неверный ключ дают одинаковый ответ.
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!expected || !crypto.timingSafeEqual(a, b)) return json(res, 404, { error: 'not found' });
    return json(res, 200, {
      ok: true,
      paid: !!order.paid,
      status: order.paid ? 'paid' : (order.paymentStatus || 'pending'),
    });
  }

  // Колбэк от платёжного мерчанта. Подпись/секрет проверяет сам провайдер.
  if (p.startsWith('/api/pay/callback/') && method === 'POST') {
    const name = p.slice('/api/pay/callback/'.length);
    const s = getSettings();
    const provider = payments.getProvider(name);
    if (!provider) { res.writeHead(404); return res.end(); }

    let body; try { body = await readBody(req); } catch (e) { res.writeHead(200); return res.end('ok'); }
    const check = provider.verifyCallback(s.payments.creds, req.headers, body);
    if (!check.ok) { res.writeHead(401); return res.end(); }

    // Отвечаем 200 сразу: мерчанты (в т.ч. Platega) ретраят колбэк, если не
    // получили ответ за минуту, и мы бы получили дубли уведомлений.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');

    const order = ordersRepo.find(check.orderId);
    // Повторный колбэк по уже оплаченному заказу игнорируем целиком: мерчанты
    // ретраят доставку, и без этой проверки менеджер получал бы по уведомлению
    // на каждую попытку.
    if (!order || order.paid) return;
    const patch = { paymentStatus: check.status };
    if (check.paid) {
      patch.paid = true;
      patch.paidAt = new Date().toISOString();
    }
    ordersRepo.update(order.id, patch);
    if (check.paid) {
      await bot.notifyManagers(s, `💳 <b>Заказ №${order.id} оплачен</b>\n\nСумма: ${money(order.total, s)}`).catch(() => {});
      if (order.user) {
        await tgApi('sendMessage', { chat_id: order.user.id, text: s.payments.successText }).catch(() => {});
      }
    }
    return;
  }

  // «написал менеджеру» — фиксируем как лид, чтобы продавец видел интерес
  if (p === '/api/inquiry' && method === 'POST') {
    if (!rateLimit(ip, 20, 60000)) return json(res, 429, { error: 'too many requests' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const s = getSettings();
    const tgUser = validateInitData(body.initData || '');
    if (!tgUser && body.initData) return json(res, 403, { error: 'invalid initData' });
    if (s.notify.enabled && s.notify.onInquiry) {
      const who = tgUser
        ? (tgUser.username ? `@${esc(tgUser.username)}` : `id <code>${tgUser.id}</code>`)
        : 'гость';
      const what = esc(String(body.subject || '').slice(0, 300));
      await bot.notifyManagers(s, `👀 <b>Интерес к товару</b>\n\n${what}\n\nОт: ${who}`).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }

  // Вход в админку из Telegram (Mini App, открытое из бота). Стоит ДО
  // токен-гейта: этот запрос сам и добывает себе пропуск. initData доказывает,
  // что человек действительно из Telegram, а список владельцев (ADMIN_CHAT_IDS
  // плюс добавленные через бота командой /owner) решает, владелец ли он.
  // Ответ на «не тот» и «не из списка» одинаковый — перебором список не выяснить.
  // Заявка с формы на сайте магазина. Сайт — отдельный сервис, ходит сюда по
  // внутреннему адресу, но через nginx эндпоинт виден и снаружи, поэтому без
  // общего ключа (X-Site-Token = SITE_LEAD_TOKEN) — отказ, а перебор ключа
  // упирается в тот же тормоз, что и вход в админку.
  if (p === '/api/inbound-lead' && method === 'POST') {
    if (!SITE_LEAD_TOKEN || MULTI) return json(res, 404, { error: 'not found' });
    const gate = authguard.check(ip);
    if (!gate.allowed) return json(res, 429, { error: 'too many attempts' });
    const given = crypto.createHash('sha256').update(String(req.headers['x-site-token'] || '')).digest();
    const want = crypto.createHash('sha256').update(SITE_LEAD_TOKEN).digest();
    if (!crypto.timingSafeEqual(given, want)) {
      authguard.fail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }
    if (!rateLimit('site-lead:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const r = await bot.notifySiteLead(getSettings(), body);
    return json(res, r.ok ? 200 : 502, r);
  }

  // Сайт магазина спрашивает: этот initData — от владельца? Сайт пускает в свою
  // админку по ответу бота, поэтому токен бота и список владельцев остаются
  // здесь. Ключ тот же, что у заявок. Неверный ключ — тормоз подбора; неверный
  // initData — просто отказ: запросы идут с адреса сайта, и чужие попытки не
  // должны запереть сайту приём заявок. Тормоз по посетителю держит сайт.
  if (p === '/api/site/tg-auth' && method === 'POST') {
    if (!SITE_LEAD_TOKEN || MULTI) return json(res, 404, { error: 'not found' });
    const gate = authguard.check(ip);
    if (!gate.allowed) return json(res, 429, { error: 'too many attempts' });
    const given = crypto.createHash('sha256').update(String(req.headers['x-site-token'] || '')).digest();
    const want = crypto.createHash('sha256').update(SITE_LEAD_TOKEN).digest();
    if (!crypto.timingSafeEqual(given, want)) {
      authguard.fail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }
    if (!rateLimit('site-auth:' + ip, 120, 60000)) return json(res, 429, { error: 'too many requests' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const user = validateInitData(String(body.initData || ''));
    if (!user || !currentTenant().isOwner(user.id)) return json(res, 403, { ok: false, error: 'not an owner' });
    return json(res, 200, {
      ok: true,
      user: { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username || '' },
    });
  }

  if (p === '/api/admin/tg-login' && method === 'POST') {
    if (!rateLimit('admin:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });
    const gate = authguard.check(ip);
    if (!gate.allowed) {
      const sec = Math.ceil(gate.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(sec));
      return json(res, 429, { error: `Слишком много неудачных попыток входа. Подождите ${sec} с.` });
    }
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const user = validateInitData(String(body.initData || ''));
    if (!user || !currentTenant().isOwner(user.id)) {
      authguard.fail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }
    authguard.succeed(ip);
    return json(res, 200, { ok: true, token: issueAdminSession(user.id), name: user.first_name || '' });
  }

  // ===== админка =====
  if (p.startsWith('/api/admin/')) {
    if (!rateLimit('admin:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });

    // Подбор пароля: общий лимит в 60 запросов в минуту неудачные попытки
    // никак не удорожал, и перебор с одного адреса шёл бесконечно. Теперь
    // после нескольких ошибок адрес уходит в растущую паузу.
    const gate = authguard.check(ip);
    if (!gate.allowed) {
      const sec = Math.ceil(gate.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(sec));
      return json(res, 429, { error: `Слишком много неудачных попыток входа. Подождите ${sec} с.` });
    }
    // Пускает либо вечный ADMIN_TOKEN, либо билет из Telegram (см. issueAdminSession)
    const givenAdminToken = String(req.headers['x-admin-token'] || '');
    if (!tokenOk(req, givenAdminToken) && !adminSessionOk(givenAdminToken)) {
      const r = authguard.fail(ip);
      if (r.retryAfterMs) {
        console.warn(`[admin] неверный токен с ${ip}: попытка ${r.fails}, пауза ${Math.ceil(r.retryAfterMs / 1000)} с`);
      }
      return json(res, 401, { error: 'unauthorized' });
    }
    authguard.succeed(ip);

    if (p === '/api/admin/settings') {
      if (method === 'GET') return json(res, 200, getSettings());
      if (method === 'PUT') {
        let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const prev = getSettings();
        const next = sanitize(mergeDeep(store.read('settings', {}), body));
        store.write('settings', next);
        // Включили или выключили магазин в чате — меню «/» у покупателей
        // обновляется сразу, без перезапуска сервиса.
        if (prev.bot.classicMenu !== next.bot.classicMenu) {
          bot.syncCommands().catch(e => console.error('[bot] syncCommands:', e.message));
        }
        return json(res, 200, next);
      }
    }

    // Превью магазина в чате для вкладки «Чат-бот». Экраны собирает тот же
    // код, что отвечает покупателям, только на присланных (ещё не сохранённых)
    // настройках — превью не может разойтись с тем, что увидит покупатель.
    if (p === '/api/admin/chatbot-preview' && method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const s = sanitize(mergeDeep(store.read('settings', {}), (body && body.settings) || {}));
      return json(res, 200, bot.chatPreview(s));
    }

    // Владельцы в Telegram: добавляют в боте (/owner + пароль + chat_id),
    // здесь — список и отзыв доступа. Базовых из ADMIN_CHAT_IDS не трогаем.
    if (p === '/api/admin/owners' && method === 'GET') {
      return json(res, 200, { owners: currentTenant().owners.list() });
    }
    const ownerRm = /^\/api\/admin\/owners\/(\d+)$/.exec(p);
    if (ownerRm && method === 'DELETE') {
      const id = Number(ownerRm[1]);
      const r = currentTenant().owners.remove(id);
      if (!r.removed) {
        return r.reason === 'env'
          ? json(res, 409, { error: 'Этот владелец прописан в .env сервера (ADMIN_CHAT_IDS) — убрать можно только там' })
          : json(res, 404, { error: 'Такого владельца нет' });
      }
      console.log(`[admin] владелец ${id} убран через панель`);
      bot.syncChatCommands(id, false).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // Подписка магазина на платформу (Stage 5). Только режим платформы и
    // только при настроенной Robokassa; иначе enabled:false и оплата ни на
    // что не влияет. Приём денег от покупателей — отдельно, в payments.js.
    if (p === '/api/admin/billing' && method === 'GET') {
      if (!billing) return json(res, 200, { enabled: false });
      const row = await registry.findShopBySubdomain(currentTenant().subdomain);
      return json(res, 200, await billing.statusForShop(row));
    }
    if (p === '/api/admin/billing/pay' && method === 'POST') {
      if (!billing) return json(res, 400, { error: 'биллинг не настроен' });
      const row = await registry.findShopBySubdomain(currentTenant().subdomain);
      try {
        const inv = await billing.createInvoice(row);
        return json(res, 200, inv);
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }

    if (p === '/api/admin/products') {
      let products = store.read('products', []);

      if (method === 'GET') return json(res, 200, products);

      if (method === 'POST') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const product = normalizeProduct({ ...b, id: Date.now() });
        if (!product.name) return json(res, 400, { error: 'нужно название' });
        products.push(product);
        store.write('products', products);
        // рассылка — только при явном флаге из формы товара
        if (b.announce === true) announceProduct(getSettings(), product, 'new');
        return json(res, 200, product);
      }

      if (method === 'PUT') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const idx = products.findIndex(x => x.id === Number(b.id));
        if (idx === -1) return json(res, 404, { error: 'не найден' });
        const old = products[idx];
        const updated = normalizeProduct({ ...old, ...b, id: old.id });
        products[idx] = updated;
        store.write('products', products);
        // Фото, убранные из карточки, стираем с диска — но только если на них
        // не ссылается другой товар. Без этого каждая замена плодила бы сирот.
        const kept = new Set([...(updated.images || []), ...(updated.thumbs || [])]);
        const referenced = new Set();
        for (const other of products) {
          if (other.id === updated.id) continue;
          for (const id of [...(other.images || []), ...(other.thumbs || [])]) referenced.add(id);
        }
        for (const id of [...(old.images || []), ...(old.thumbs || [])]) {
          if (id && !kept.has(id) && !referenced.has(id)) await store.deleteImage(id);
        }
        if (b.announce === true) {
          const priceChanged = old.price !== updated.price;
          announceProduct(getSettings(), updated, priceChanged ? 'price' : 'new', priceChanged ? old.price : null);
        }
        return json(res, 200, updated);
      }

      if (method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        const victim = products.find(x => x.id === id);
        if (victim) {
          // чистим картинки, иначе диск постепенно забивается мусором
          for (const img of [...(victim.images || []), ...(victim.thumbs || [])]) await store.deleteImage(img);
        }
        store.write('products', products.filter(x => x.id !== id));
        return json(res, 200, { ok: true });
      }
    }

    // изменение порядка товаров в каталоге
    if (p === '/api/admin/reorder' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const order = (b.ids || []).map(Number);
      const products = store.read('products', []);
      const sorted = [...products].sort((a, z) => {
        const ia = order.indexOf(a.id), iz = order.indexOf(z.id);
        return (ia === -1 ? 1e9 : ia) - (iz === -1 ? 1e9 : iz);
      });
      store.write('products', sorted);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/upload' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 413, { error: 'файл слишком большой' }); }
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(b.dataUrl || '');
      if (!m) return json(res, 400, { error: 'ожидается dataUrl вида data:image/...;base64,...' });
      const id = await store.saveImage(m[1], m[2]);
      return json(res, 200, { id });
    }

    if (p === '/api/admin/views' && method === 'GET') return json(res, 200, store.read('views', {}));

    // Аудит картинок: товары с пропавшими файлами + битый логотип. Типичный
    // сценарий — перенос/восстановление без папки images. Витрина уже прячет
    // дыры заглушками, а этот список позволяет переотправить фото адресно.
    if (p === '/api/admin/images/audit' && method === 'GET') {
      const list = store.read('products', []);
      const broken = [];
      for (const pr of list) {
        const missing = [...new Set([...(pr.images || []), ...(pr.thumbs || [])])].filter(id => id && !store.imagePath(id));
        if (missing.length) broken.push({ id: pr.id, name: pr.name, missing });
      }
      const s = getSettings();
      const logoBroken = Boolean(s.brand.logoImage) && !store.imagePath(s.brand.logoImage);
      return json(res, 200, { broken, logoBroken });
    }

    // Выгрузка в CSV — всё, включая архив. Отдаём файлом, а не JSON: продавцу
    // нужно открыть это в Excel, а не разбирать глазами.
    if (p === '/api/admin/orders/export.csv' && method === 'GET') {
      const csv = ordersRepo.toCSV(ordersRepo.all(), getSettings());
      const buf = Buffer.from(csv, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }

    if (p === '/api/admin/orders') {
      if (method === 'GET') {
        return json(res, 200, {
          ...ordersRepo.list({
            status: url.searchParams.get('status') || '',
            offset: url.searchParams.get('offset'),
            limit: url.searchParams.get('limit'),
          }),
          counts: ordersRepo.stats().byStatus,
          statuses: ordersRepo.STATUSES.map(k => [k, ordersRepo.STATUS_LABELS[k]]),
        });
      }
      // Смена статуса. Отдельный метод, а не PUT всего заказа: заказ — это
      // документ покупателя, менять в нём что-то кроме статуса продавцу нельзя.
      if (method === 'PATCH') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const updated = ordersRepo.setStatus(b.id, String(b.status || ''));
        if (!updated) return json(res, 400, { error: 'заказ не найден или статус неизвестен' });
        return json(res, 200, { ok: true, order: updated });
      }
      if (method === 'DELETE') { ordersRepo.clearAll(); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/admin/stats' && method === 'GET') {
      const products = store.read('products', []);
      const views = store.read('views', {});
      // Выручка считается без отменённых заказов — иначе цифра в админке
      // расходится с деньгами на счёте, и доверия к ней нет.
      const o = ordersRepo.stats();
      return json(res, 200, {
        products: products.length,
        orders: o.total,
        revenue: o.revenue,
        ordersByStatus: o.byStatus,
        views: Object.values(views).reduce((a, b) => a + b, 0),
        users: Object.keys(store.read('users', {})).length,
        botConnected: !!tg.BOT_TOKEN,
        // Что админке знать про режим работы: в платформе токен бота задаётся
        // из самой админки, в одиночной установке — только в .env.
        platform: {
          multitenant: MULTI,
          botUsername: MULTI ? (currentTenant().botUsername || '') : '',
          botMode: MULTI ? currentTenant().bot.currentMode() : '',
        },
      });
    }

    // Состояние VPS для карточки «Сервер» в админке (за токеном, наружу нельзя)
    if (p === '/api/admin/system' && method === 'GET') {
      return json(res, 200, await systemStatus());
    }

    // Самодиагностика: показывает продавцу, что именно сломано, вместо того
    // чтобы он читал journalctl. Каждая проверка возвращает причину отказа.
    if (p === '/api/admin/diagnostics' && method === 'GET') {
      const s = getSettings();
      const checks = [];
      const add = (id, title, ok, detail, fix) => checks.push({ id, title, ok, detail, fix });

      // В режиме платформы у арендатора нет ни SSH, ни .env, ни systemd —
      // советовать ему «впишите токен в /opt/tg-shop/.env» бессмысленно, а
      // заодно это раскрывает пути и модель развёртывания платформы.
      add('token', 'Токен бота задан', !!tg.BOT_TOKEN,
        tg.BOT_TOKEN ? 'токен бота на месте' : 'токен бота не задан',
        MULTI
          ? 'Получите токен у @BotFather (/newbot) и вставьте его на вкладке «Бот» — магазин подхватит его сам.'
          : 'Впишите токен от @BotFather в .env магазина и перезапустите сервис: systemctl restart tg-shop');

      if (tg.BOT_TOKEN) {
        const me = await tgApi('getMe', {}, { retries: 0, timeoutMs: 12000 });
        if (me.ok) {
          add('api', `Связь с Telegram (@${me.result.username})`, true, `API: ${tg.API_BASE}`, '');
        } else if (me.network) {
          add('api', 'Связь с Telegram', false, me.description,
            'Сервер не может достучаться до api.telegram.org. Обычно это блокировка у хостера. ' +
            'Проверьте на сервере: curl -sS -m 10 https://api.telegram.org | head. ' +
            'Если не отвечает — поднимите прокси и укажите TELEGRAM_API_BASE в .env, либо смените хостинг.');
        } else {
          add('api', 'Связь с Telegram', false, me.description || 'Telegram отклонил запрос',
            'Скорее всего неверный BOT_TOKEN — перевыпустите его через /revoke у @BotFather');
        }
      }

      add('publicUrl', 'PUBLIC_URL настроен', /^https:\/\//i.test(currentTenant().publicUrl),
        currentTenant().publicUrl || 'не задан',
        'Без https-адреса Telegram не откроет мини-апп и не отдаст фото при публикации в канал');

      // Отдельная проверка кнопки «Открыть»: web_app-кнопки и кнопка меню
      // требуют https (t.me-ссылка или домен, привязанный к боту в BotFather).
      const appUrl = bot.shopWebAppUrl(s);
      const isTme = /^https:\/\/(t\.me|telegram\.me)\//i.test(appUrl);
      add('webapp', 'Ссылка мини-аппа для кнопок web_app', !!appUrl,
        appUrl || 'нет ни t.me-ссылки в разделе «Канал», ни https в PUBLIC_URL',
        'Лучший вариант — ссылка вида t.me/бот/app из @BotFather (/newapp), её впишите в «Канал» → ссылка мини-аппа. ' +
        (isTme ? '' : 'Для прямого https-домена также привяжите его к боту: @BotFather → /setdomain. '));

      add('notify', 'Указан получатель уведомлений', s.notify.chatIds.length > 0,
        s.notify.chatIds.length ? `получателей: ${s.notify.chatIds.length}` : 'список пуст',
        'Вкладка «Уведомления» → добавьте свой chat_id (узнать: отправьте боту /id)');

      add('products', 'В каталоге есть товары', store.read('products', []).length > 0,
        `товаров: ${store.read('products', []).length}`, 'Вкладка «Товары» → добавьте первый товар');

      if (s.commerce.mode === 'manager') {
        add('manager', 'Задан контакт менеджера', !!s.manager.buyUrl,
          s.manager.buyUrl || 'пусто',
          'Режим «только через менеджера» без ссылки — кнопка покупки не сработает');
      }
      if (s.payments.enabled) {
        const prov = payments.getProvider(s.payments.provider);
        const missing = prov ? prov.fields.filter(f => !s.payments.creds[f.key]).map(f => f.label) : [];
        add('payments', 'Онлайн-оплата настроена', !!prov && missing.length === 0,
          missing.length ? `не заполнено: ${missing.join(', ')}` : `провайдер: ${prov ? prov.label : '—'}`,
          'Вкладка «Оплата» → заполните ключи мерчанта');
      }

      return json(res, 200, { checks, apiBase: tg.API_BASE, botMode: currentTenant().botMode || 'polling' });
    }

    if (p === '/api/admin/payment-providers' && method === 'GET') {
      return json(res, 200, payments.providerSchema());
    }

    // Подключить или сменить бота уже после регистрации. Лендинг обещает
    // «токен можно добавить позже», но способа сделать это не было вообще:
    // registry.setBotToken существовал и не вызывался ниоткуда. Токен шифруется
    // тем же ключом платформы, что и при регистрации, и бот перезапускается
    // на месте — без рестарта процесса и без простоя соседних магазинов.
    if (p === '/api/admin/bot-token' && method === 'PUT') {
      if (!MULTI) return json(res, 400, { error: 'в одиночном режиме токен задаётся в .env' });
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const token = String(b.token || '').trim();
      // Формат токена от BotFather: <цифры>:<буквенно-цифровая часть>.
      // Проверяем до похода в Telegram, чтобы очевидный мусор не ждал сети.
      if (token && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
        return json(res, 400, { error: 'не похоже на токен от @BotFather' });
      }

      const t = currentTenant();
      if (token) {
        // Токен принимаем только рабочий: иначе продавец сохранит опечатку и
        // будет гадать, почему бот молчит.
        const probe = createTenantTelegram(token);
        const me = await probe.tgApi('getMe', {}, { retries: 0, timeoutMs: 12000 });
        if (!me.ok) return json(res, 400, { error: `Telegram отклонил токен: ${me.description}` });

        // Занятость чужим магазином: один и тот же бот в двух магазинах — это
        // 409 на опросе и перехваченные заказы на вебхуке.
        const [rows] = await platformDb.query(
          'SELECT subdomain FROM shops WHERE bot_username = ? AND id <> ?',
          [me.result.username, t.shopId]).catch(() => [[]]);
        if (rows && rows.length) {
          return json(res, 409, { error: `бот @${me.result.username} уже подключён к другому магазину` });
        }

        await registry.setBotToken(t.shopId, Buffer.from(encryptSecret(token, SECRET_KEY), 'utf8'), me.result.username);
        await rebuildTenant(t.subdomain);
        return json(res, 200, { ok: true, username: me.result.username });
      }

      // Пустой токен — отключить бота: снимаем вебхук и забываем токен.
      await t.bot.stop();
      await registry.setBotToken(t.shopId, null, null);
      await rebuildTenant(t.subdomain);
      return json(res, 200, { ok: true, username: '' });
    }

    if (p === '/api/admin/test-notification' && method === 'POST') {
      const s = getSettings();
      if (!s.notify.chatIds.length) return json(res, 400, { error: 'Сначала укажи хотя бы один chat_id получателя' });
      const results = [];
      for (const id of s.notify.chatIds) {
        const r = await tgApi('sendMessage', { chat_id: id, text: '🔔 Тестовое уведомление — всё настроено верно.' });
        results.push({ id, ok: !!r.ok, error: r.description || '' });
      }
      const bad = results.filter(r => !r.ok);
      if (bad.length) return json(res, 502, { error: bad.map(b => `${b.id}: ${b.error}`).join('; ') });
      return json(res, 200, { ok: true, sent: results.length });
    }

    if (p === '/api/admin/publish' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const s = getSettings();
      const product = store.read('products', []).find(x => x.id === Number(b.productId));
      if (!product) return json(res, 404, { error: 'товар не найден' });
      if (!s.channel.channelId) return json(res, 400, { error: 'Укажи канал в разделе «Канал»' });
      if (!s.channel.miniAppLink) return json(res, 400, { error: 'Укажи ссылку мини-аппа в разделе «Канал»' });

      const link = s.channel.miniAppLink + (s.channel.miniAppLink.includes('?') ? '&' : '?') + 'startapp=' + product.id;
      const caption = bot.fill(s.channel.postTemplate, {
        name: product.name,
        description: product.description || '',
        price: s.commerce.priceHidden ? s.commerce.priceHiddenText : money(product.price, s),
        shop: s.brand.shopName,
        category: product.category || '',
      }).slice(0, 1024);

      const payload = { chat_id: s.channel.channelId, reply_markup: { inline_keyboard: [[{ text: s.channel.postButtonText, url: link }]] } };
      const publicBase = currentTenant().publicUrl;
      let apiMethod = 'sendMessage';
      if (product.images && product.images[0] && publicBase) {
        apiMethod = 'sendPhoto';
        payload.photo = `${publicBase}/api/image?id=${product.images[0]}`;
        payload.caption = caption;
      } else {
        payload.text = caption;
      }
      const r = await tgApi(apiMethod, payload);
      if (!r.ok) return json(res, 502, { error: r.description || 'Telegram отклонил публикацию' });
      return json(res, 200, { ok: true });
    }

    // экспорт/импорт всей конфигурации — перенос магазина на другой сервер в один клик
    if (p === '/api/admin/export' && method === 'GET') {
      return json(res, 200, {
        settings: getSettings(),
        products: store.read('products', []),
        exportedAt: new Date().toISOString(),
      });
    }
    if (p === '/api/admin/import' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (b.settings) store.write('settings', sanitize(b.settings));
      if (Array.isArray(b.products)) store.write('products', b.products.map(normalizeProduct));
      return json(res, 200, { ok: true });
    }

    // ===== резервные копии =====
    // Снимок = вся папка данных (JSON + картинки) с манифестом sha256.
    // Конфиг и список — в GET; включение/интервал/retention — в PUT.
    if (p === '/api/admin/backup') {
      if (method === 'GET') return json(res, 200, await backup.status());
      if (method === 'PUT') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        try { return json(res, 200, await backup.updateConfig(b)); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (method === 'DELETE') {
        try { await backup.remove(url.searchParams.get('name')); }
        catch (e) { return json(res, e.status || 500, { error: e.message }); }
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/backup/run' && method === 'POST') {
      try { return json(res, 200, { ok: true, snapshot: await backup.runNow('manual') }); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }

    // Восстановление откатывает данные целиком — только с подтверждением в UI
    // и после сверки контрольных сумм снимка (см. backup.js).
    if (p === '/api/admin/backup/restore' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      try { return json(res, 200, await backup.restore(b.name)); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }

    if (p === '/api/admin/backup/download' && method === 'GET') {
      let buf;
      try { buf = await backup.archive(url.searchParams.get('name')); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
      const name = url.searchParams.get('name');
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="backup-${name}.tar.gz"`,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }

    return json(res, 404, { error: 'unknown admin endpoint' });
  }

  return json(res, 404, { error: 'not found' });
}

function normalizeProduct(b) {
  const arr = (v, n) => (Array.isArray(v) ? v.filter(Boolean).slice(0, n) : []);
  return {
    id: Number(b.id) || Date.now(),
    name: String(b.name || '').trim().slice(0, 80),
    description: String(b.description || '').slice(0, 1000),
    category: String(b.category || '').trim().slice(0, 40),
    price: Math.max(0, Number(b.price) || 0),
    oldPrice: b.oldPrice === '' || b.oldPrice == null ? null : Math.max(0, Number(b.oldPrice) || 0),
    stock: (b.stock === '' || b.stock === null || b.stock === undefined) ? null : Math.max(0, Number(b.stock) || 0),
    featured: !!b.featured,
    hidden: !!b.hidden,
    badge: String(b.badge || '').slice(0, 16),
    images: arr(b.images, 8),
    thumbs: arr(b.thumbs, 8),
  };
}

// ---------- платформа (MULTITENANT=1) ----------
// Реестр в MySQL, у каждого магазина свой поддомен и своя папка данных в
// MULTI_ROOT. В файловом режиме вся секция молчит: переменные пусты.
let registry = null;
let platformDb = null;
let billing = null; // подписка магазинов; null до bootPlatform
const tenantsBySub = new Map(); // subdomain -> tenant

// Собирает арендатора из строки реестра. Данные магазина живут в MySQL
// (shop_docs через store-db), на диске — только картинки. Токен бота
// расшифровывается; не расшифровался (сменили SECRET_KEY) — магазин стартует
// без бота, витрина и админка работают.
async function buildTenantFromRow(row) {
  const { decryptSecret } = require('./secrets');
  const { createDbStore } = require('./store-db');
  const { createDisabledBackup } = require('./backup');
  const dataDir = path.join(MULTI_ROOT, row.subdomain);
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });

  let botToken = '';
  if (row.bot_token_enc) {
    try {
      botToken = decryptSecret(Buffer.from(row.bot_token_enc).toString('utf8'), SECRET_KEY);
    } catch (e) {
      console.error(`[platform] ${row.subdomain}: токен бота не расшифровался (${e.message}) — старт без бота`);
    }
  }

  const store = await createDbStore({ db: platformDb, shopId: row.shop_id, dataDir });

  // Хэш пароля обязан быть ровно 32 байтами: timingSafeEqual бросает на
  // разной длине, и мусор в колонке уронил бы каждый запрос к админке
  // невнятной ошибкой вместо честного отказа.
  const adminHash = Buffer.from(String(row.admin_token_hash || ''), 'hex');
  if (adminHash.length !== 32) {
    throw new Error(`${row.subdomain}: admin_token_hash повреждён (${adminHash.length} байт вместо 32)`);
  }

  // Ключ подписи билетов. У магазинов, заведённых до миграции 0004, колонка
  // пуста — досыпаем ключ на месте, чтобы не разлогинивать всех разом при
  // обновлении и не оставлять подпись на хэше пароля.
  let sessionKey = row.session_key ? String(row.session_key) : '';
  if (!sessionKey) {
    sessionKey = crypto.randomBytes(32).toString('hex');
    try {
      await registry.setSessionKey(row.shop_id, sessionKey);
      console.log(`[platform] ${row.subdomain}: выдан отдельный ключ подписи сессий`);
    } catch (e) {
      console.error(`[platform] ${row.subdomain}: не удалось сохранить ключ сессий (${e.message})`);
    }
  }

  const t = createTenant({
    id: `shop-${row.shop_id}`,
    dataDir,
    store,
    botToken,
    adminToken: '',
    adminHash,
    sessionKey,
    publicUrl: `https://${row.subdomain}.${MULTI_DOMAIN}`,
    apiBase: process.env.TELEGRAM_API_BASE,
    botMode: process.env.BOT_MODE,
    strictWebhook: String(process.env.BOT_STRICT_WEBHOOK || '') === '1',
    adminChatIds: Array.isArray(row.admin_chat_ids) ? row.admin_chat_ids : [],
  });
  t.subdomain = row.subdomain;
  t.shopId = row.shop_id;
  t.botUsername = row.bot_username || '';
  t.status = row.status;
  t.createdAt = row.created_at || null;
  // Данные в БД — снимки папки не применяются; интерфейс у заглушки тот же.
  t.backup = createDisabledBackup('данные магазина в MySQL — снимки папки не применяются');
  return t;
}

// shop1.example.ru -> арендатор shop1; www/голый домен -> null (это платформа).
// Статус здесь не фильтр: приостановленный магазин тоже резолвится, чтобы
// отдать 402 витрине и пустить продавца в админку за продлением.
function resolveTenantByHost(hostRaw) {
  if (!MULTI_DOMAIN) return null;
  const host = String(hostRaw || '').toLowerCase().split(':')[0];
  if (!host.endsWith('.' + MULTI_DOMAIN)) return null;
  const sub = host.slice(0, -(MULTI_DOMAIN.length + 1));
  if (!sub || sub.includes('.')) return null;
  const t = tenantsBySub.get(sub);
  return t && t.status !== 'deleted' ? t : null;
}

function isPlatformHost(hostRaw) {
  const host = String(hostRaw || '').toLowerCase().split(':')[0];
  return host === MULTI_DOMAIN || host === `www.${MULTI_DOMAIN}`;
}

// Отдельный счётчик регистраций: общий rate-limit заказов здесь не место.
const regHits = new Map();
function regRateLimit(ip, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const rec = regHits.get(ip);
  if (!rec || now - rec.start > windowMs) { regHits.set(ip, { start: now, n: 1 }); return true; }
  rec.n += 1;
  return rec.n <= max;
}

async function handlePlatform(req, res, url) {
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // Регистрация магазина: строки в реестре + папка данных + одноразовый
  // пароль админки. Токен бота необязателен — можно добавить позже.
  if (url.pathname === '/api/platform/register' && method === 'POST') {
    if (!regRateLimit(ip)) return json(res, 429, { error: 'Слишком много регистраций — попробуйте позже' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const { provisionShop } = require('./provision');
    let p;
    try {
      p = await provisionShop({
        registry,
        dataRoot: MULTI_ROOT,
        subdomain: body.subdomain,
        shopName: body.shopName,
        email: body.email,
        botToken: body.botToken,
        secretKey: SECRET_KEY,
      });
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }

    const row = await registry.findShopBySubdomain(p.subdomain);
    const t = await buildTenantFromRow(row);
    tenantsBySub.set(p.subdomain, t);
    t.bot.start();
    t.backup.start();
    console.log(`[platform] зарегистрирован магазин ${p.subdomain} (${p.shopName})`);
    return json(res, 200, { ok: true, subdomain: p.subdomain, url: t.publicUrl, adminToken: p.adminToken });
  }

  if (url.pathname === '/api/platform/shops' && method === 'GET') {
    const rows = await registry.listActiveShops();
    return json(res, 200, {
      shops: rows.filter(r => r.status === 'active').map(r => ({
        subdomain: r.subdomain, title: r.title, url: `https://${r.subdomain}.${MULTI_DOMAIN}`,
      })),
    });
  }

  // Result-уведомление Robokassa: ответ строго текстом «OK<InvId>», иначе
  // платёжка шлёт уведомление повторно. GET и POST — касса ходит обоими,
  // в POST параметры приходят form-encoded в теле.
  if (url.pathname === '/api/platform/billing/result') {
    if (!billing) return json(res, 404, { error: 'биллинг не настроен' });
    const params = Object.fromEntries(url.searchParams);
    if (method === 'POST') {
      const chunks = [];
      let size = 0;
      let overflow = false;
      for await (const c of req) {
        size += c.length;
        // Оборвать чтение мало: недочитанный запрос оставляет сокет в
        // подвешенном состоянии. Досасываем поток до конца, просто перестав
        // копить данные.
        if (size > 64 * 1024) { overflow = true; continue; }
        chunks.push(c);
      }
      if (overflow) return json(res, 413, { error: 'слишком большое уведомление' });
      Object.assign(params, Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    }
    const r = await billing.handleResult(params);
    if (!r.ok) return json(res, r.status, { error: r.error });
    if (r.subdomain) await syncShopAfterPay(r.subdomain);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`OK${r.invId}`);
  }

  // Редиректы продавца после кассы — обратно в его админку.
  if (url.pathname === '/api/platform/billing/success' || url.pathname === '/api/platform/billing/fail') {
    const paid = url.pathname.endsWith('success');
    const sub = billing ? await billing.redirectFor(Object.fromEntries(url.searchParams)) : null;
    const target = sub
      ? `https://${sub}.${MULTI_DOMAIN}/admin.html?${paid ? 'paid=1' : 'payfail=1'}`
      : `https://${MULTI_DOMAIN}/`;
    res.writeHead(302, { Location: target });
    return res.end();
  }

  return json(res, 404, { error: 'unknown platform endpoint' });
}

// Тексты согласия собираем на сервере: адреса оферты и политики обработки
// данных задаются переменными окружения, а не зашиты в разметку. Пока их не
// задали, чекбокс остаётся, но без ссылок — согласие всё равно требуется,
// просто ссылаться пока не на что.
function agreementHtml() {
  const offer = String(process.env.PLATFORM_OFFER_URL || '').trim();
  const privacy = String(process.env.PLATFORM_PRIVACY_URL || '').trim();
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  const a = offer ? link(offer, 'условиями сервиса') : 'условиями сервиса';
  const b = privacy ? link(privacy, 'обработкой персональных данных') : 'обработкой персональных данных';
  return `Соглашаюсь с ${a} и ${b}`;
}

function servePlatform(res, url) {
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/platform.html') {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'platform.html'), 'utf8');
    html = html.replace(
      'Соглашаюсь с условиями сервиса и обработкой персональных данных',
      agreementHtml());
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }
  return json(res, 404, { error: 'not found' });
}

// Пересобрать арендатора из свежей строки реестра и подменить его в роутере.
// Нужно там, где поменялось то, что читается один раз при сборке: токен бота,
// список владельцев, ключи. Старого гасим аккуратно — иначе его бот останется
// зарегистрированным у Telegram и продолжит тянуть апдейты на тот же адрес.
async function rebuildTenant(subdomain) {
  const row = await registry.findShopBySubdomain(subdomain);
  if (!row) return null;
  const old = tenantsBySub.get(subdomain);
  if (old) {
    await old.bot.stop();
    old.backup.stop();
  }
  const fresh = await buildTenantFromRow(row);
  tenantsBySub.set(subdomain, fresh);
  if (fresh.status === 'active') {
    fresh.bot.start();
    fresh.backup.start();
  }
  return fresh;
}

// Оплата прошла: магазин уже active в БД (делает billing), здесь синхроним
// кэш роутера и возвращаем бота в эфир.
async function syncShopAfterPay(subdomain) {
  const t = tenantsBySub.get(subdomain);
  if (t && t.status !== 'active') {
    t.status = 'active';
    try { t.bot.start(); } catch (e) { console.error(`[platform] ${subdomain}: бот не поднялся после оплаты: ${e.message}`); }
  }
}

// Приостановленный магазин: витрина закрыта (402), админка и оплата доступны.
function serveSuspended(res, url) {
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Магазин приостановлен</title></head>'
      + '<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f4f7;color:#222">'
      + '<div style="max-width:420px;padding:28px;border-radius:20px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.08);text-align:center">'
      + '<h1 style="font-size:20px;margin:0 0 12px">Магазин приостановлен</h1>'
      + '<p style="margin:0 0 16px;color:#555">Не оплачена подписка на платформу. Откройте админку и продлите доступ — витрина сразу вернётся.</p>'
      + '<a href="/admin.html" style="display:inline-block;padding:10px 22px;border-radius:14px;background:#0a84ff;color:#fff;text-decoration:none;font-weight:600">Войти в админку</a>'
      + '</div></body></html>';
    res.writeHead(402, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  return json(res, 402, { error: 'магазин приостановлен: не оплачена подписка, войдите в админку' });
}

// Пути, которые остаются доступны приостановленному магазину: админка и её
// статика — чтобы продавец мог войти и оплатить продление.
function suspendedAllowed(p) {
  return p === '/admin.html' || p.startsWith('/api/admin/')
    || p === '/shared.js' || p === '/theme-core.js' || p === '/favicon.ico'
    // Вебхук принимаем даже у приостановленного магазина. Отдавать Telegram
    // отказ нельзя: он считает это сбоем доставки и ретраит один и тот же
    // апдейт часами, наматывая запросы на весь процесс. Приняли, ответили
    // 200 — и внутри тихо ничего не сделали (см. проверку статуса в ручке).
    || p === '/api/webhook';
}

// Поднимает реестр и всех зарегистрированные магазины. Вызывается в listen:
// пара запросов в окно загрузки получат «магазин не найден» — это нормально.
async function bootPlatform() {
  const { createDb, dbConfigFromEnv } = require('./db');
  const { createMigrator } = require('./migrations');
  const { createRegistry } = require('./registry');
  const { createBilling } = require('./billing');
  platformDb = createDb(dbConfigFromEnv());
  await createMigrator({ db: platformDb }).up(); // платформа всегда на последней схеме
  registry = createRegistry(platformDb);

  // Биллинг опционален: без ROBOKASSA_LOGIN/паролей магазины работают бесплатно.
  billing = createBilling({
    db: platformDb, registry,
    cfg: {
      login: process.env.ROBOKASSA_LOGIN || '',
      pass1: process.env.ROBOKASSA_PASS1 || '',
      pass2: process.env.ROBOKASSA_PASS2 || '',
      isTest: String(process.env.ROBOKASSA_IS_TEST || '').trim() === '1',
      price: Number(process.env.BILLING_PRICE) || 990,
      periodDays: Number(process.env.BILLING_PERIOD_DAYS) || 30,
      trialDays: process.env.BILLING_TRIAL_DAYS === '' ? 0 : (Number(process.env.BILLING_TRIAL_DAYS) || 14),
      platformBaseUrl: `https://${MULTI_DOMAIN}`,
    },
  });

  const rows = await registry.listBootShops();
  for (const row of rows) {
    if (row.status === 'deleted') continue;
    const full = await registry.findShopBySubdomain(row.subdomain);
    tenantsBySub.set(row.subdomain, await buildTenantFromRow(full));
  }

  // Просроченные подписки -> suspended. Биллинг выключен — вызов безвреден.
  const suspended = await billing.enforce();
  for (const s of suspended) {
    const t = tenantsBySub.get(s.subdomain);
    if (t) t.status = 'suspended';
    console.log(`[billing] магазин ${s.subdomain} приостановлен: подписка просрочена`);
  }

  await syncShopStatuses();
  // Периодически сверяем кэш роутера с базой и добираем новые магазины.
  // Без этого статус, изменённый в БД (руками, из будущей админки платформы,
  // другим процессом), не давал никакого эффекта до перезапуска: витрина
  // заблокированного магазина продолжала отдавать 200.
  setInterval(() => {
    billing.enforce()
      .then(list => { for (const s of list) console.log(`[billing] магазин ${s.subdomain} приостановлен: подписка просрочена`); })
      .then(syncShopStatuses)
      .catch(e => console.error('[platform] синхронизация статусов:', e.message));
  }, STATUS_SYNC_MS).unref();
}

// Как часто сверять кэш арендаторов с реестром.
const STATUS_SYNC_MS = 60 * 1000;

// Приводит кэш роутера в соответствие с базой: меняет статусы, поднимает и
// глушит ботов, подхватывает магазины, заведённые мимо этого процесса.
async function syncShopStatuses() {
  if (!registry) return;
  let rows;
  try { rows = await registry.listBootShops(); }
  catch (e) { console.error('[platform] реестр недоступен:', e.message); return; }

  const alive = new Set();
  for (const row of rows) {
    alive.add(row.subdomain);
    const t = tenantsBySub.get(row.subdomain);

    if (!t) {
      // магазин появился в базе, пока процесс работал
      try {
        const full = await registry.findShopBySubdomain(row.subdomain);
        const fresh = await buildTenantFromRow(full);
        tenantsBySub.set(row.subdomain, fresh);
        if (fresh.status === 'active') { fresh.bot.start(); fresh.backup.start(); }
        console.log(`[platform] подхвачен магазин ${row.subdomain} (${row.status})`);
      } catch (e) {
        console.error(`[platform] ${row.subdomain}: не поднялся — ${e.message}`);
      }
      continue;
    }

    if (t.status === row.status) continue;
    const was = t.status;
    t.status = row.status;
    if (row.status === 'active') {
      try { t.bot.start(); } catch (e) { console.error(`[platform] ${row.subdomain}: бот не поднялся — ${e.message}`); }
    } else {
      t.bot.stop();
    }
    console.log(`[platform] ${row.subdomain}: статус ${was} → ${row.status}`);
  }

  // Магазин удалили из базы или пометили deleted — гасим бота и убираем из роутера.
  for (const [sub, t] of tenantsBySub) {
    if (alive.has(sub)) continue;
    t.bot.stop();
    tenantsBySub.delete(sub);
    console.log(`[platform] магазин ${sub} снят с обслуживания`);
  }
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Проверка живости для update.sh и мониторинга: отвечает раньше любого
    // роутинга по арендаторам, не трогает ни Telegram, ни базу, ни диск.
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return json(res, 200, { ok: true });
    }
    if (MULTI) {
      // Голый домен — лендинг платформы и регистрация.
      if (isPlatformHost(req.headers.host)) {
        if (url.pathname.startsWith('/api/platform/')) return await handlePlatform(req, res, url);
        return servePlatform(res, url);
      }
      const t = resolveTenantByHost(req.headers.host);
      if (!t) return json(res, 404, { error: `магазин не найден — зарегистрируйтесь на ${MULTI_DOMAIN}` });
      // Подписка просрочена: витрина закрыта, админка — нет (там оплата).
      if (t.status !== 'active' && !suspendedAllowed(url.pathname)) {
        return serveSuspended(res, url);
      }
      // Весь дальнейший код запроса видит «своего» арендатора через als.
      return await als.run({ tenant: t }, async () => {
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        return await serveStatic(req, res, url.pathname);
      });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[http]', req.method, url.pathname, e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  if (MULTI) {
    try {
      await bootPlatform();
    } catch (e) {
      console.error('[platform] старт не удался:', e.message);
      process.exit(1);
    }
    console.log(`[platform] http://${HOST}:${PORT}  (домен: ${MULTI_DOMAIN}, магазинов: ${tenantsBySub.size}, данные: ${MULTI_ROOT}${billing && billing.enabled ? ', биллинг: Robokassa' : ', биллинг: выключен'})`);
    // Боты и бэкапы — только активным; приостановленные ждут оплаты.
    for (const t of tenantsBySub.values()) {
      if (t.status !== 'active') continue;
      t.bot.start();
      t.backup.start();
    }
    // Раз в час проверяем просрочки: billing сам вернёт [], если выключен.
    setInterval(async () => {
      try {
        const list = await billing.enforce();
        for (const s of list) {
          const t = tenantsBySub.get(s.subdomain);
          if (t) { t.status = 'suspended'; t.bot.stop(); }
          console.log(`[billing] магазин ${s.subdomain} приостановлен: подписка просрочена`);
        }
      } catch (e) { console.error('[billing] enforce:', e.message); }
    }, 60 * 60 * 1000);
  } else {
    console.log(`[web] http://${HOST}:${PORT}  (данные: ${solo.store.DATA_DIR})`);
    solo.bot.start();
    solo.backup.start();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const all = MULTI ? [...tenantsBySub.values()] : [solo];
    for (const t of all) { t.bot.stop(); t.backup.stop(); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
