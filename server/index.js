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
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* нет .env — значит переменные пришли из окружения */ }
})();

const authguard = require('./authguard');
const { createTenant } = require('./tenant');
const { createBackupManager } = require('./backup');
const { sanitize, mergeDeep } = require('./settings');
const { esc } = require('./telegram');
const payments = require('./payments');
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

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN не задан в .env — админка была бы открыта всем. Выхожу.');
  process.exit(1);
}

// Единственный пока арендатор, собранный из окружения — ровно то же, что
// модули раньше читали каждый сам за себя. Когда появится роутинг по домену,
// здесь встанет реестр арендаторов, а обработчики ниже не изменятся: они уже
// работают с объектом, а не с глобальным состоянием.
const tenant = createTenant({
  id: process.env.SHOP_ID || '',
  dataDir: process.env.DATA_DIR,
  botToken: process.env.BOT_TOKEN,
  adminToken: ADMIN_TOKEN,
  publicUrl: process.env.PUBLIC_URL,
  apiBase: process.env.TELEGRAM_API_BASE,
  botMode: process.env.BOT_MODE,
  adminChatIds: ADMIN_CHAT_IDS,
});

// Короткие имена, чтобы не переписывать полторы тысячи строк обработчиков.
// На следующем этапе эти строки заменит выбор арендатора по домену запроса.
const store = tenant.store;
const ordersRepo = tenant.orders;
const bot = tenant.bot;
const { tgApi, validateInitData, BOT_TOKEN, API_BASE } = tenant.telegram;

// Резервные копии папки данных: снимки по расписанию и вручную из админки.
// BACKUP_DIR не задан — копии ложатся в backups/ рядом с папкой данных.
const backup = createBackupManager({
  dataDir: store.DATA_DIR,
  backupsRoot: process.env.BACKUP_DIR,
  tenantId: tenant.id || 'shop',
  store,
});

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
  return crypto.timingSafeEqual(hash, tenant.adminHash);
}

// Админка из Telegram выдаёт билеты вместо вечного ADMIN_TOKEN: подпись на
// ключе ADMIN_TOKEN + срок жизни. Таблицы сессий нет — отзыв происходит сам:
// билет протух, владелец выпал из ADMIN_CHAT_IDS, ADMIN_TOKEN поменялся.
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function issueAdminSession(userId) {
  const exp = Date.now() + ADMIN_SESSION_TTL_MS;
  const payload = `a1.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function adminSessionOk(raw) {
  const m = /^a1\.(-?\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(String(raw || ''));
  if (!m) return false;
  const [, uid, exp, sig] = m;
  if (Number(exp) < Date.now()) return false;
  // выпавших из списка допуска не пускаем даже с живой подписью
  if (!ADMIN_CHAT_IDS.includes(Number(uid))) return false;
  const expected = crypto.createHmac('sha256', ADMIN_TOKEN).update(`a1.${uid}.${exp}`).digest('hex');
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

const getSettings = () => tenant.settings();

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
// Считается по «сырым» настройкам из хранилища: они лежат в памяти, так что
// это просто хэш небольшой строки на каждый запрос страницы.
let fpCacheSrc = null, fpCacheVal = '0';
function settingsFingerprint() {
  const src = JSON.stringify(store.read('settings', {}));
  if (src !== fpCacheSrc) {
    fpCacheSrc = src;
    fpCacheVal = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  }
  return fpCacheVal;
}

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

// Проверка промокода и расчёт скидки. Живёт на сервере и вызывается ДВАЖДЫ:
// при вводе кода покупателем (показать сумму) и при оформлении заказа (посчитать
// по-настоящему). Клиенту доверять нельзя — он мог бы прислать любую скидку.
function applyPromo(s, rawCode, total) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Введите промокод' };
  if (!s.promo.enabled) return { ok: false, error: 'Промокоды сейчас не принимаются' };

  const p = s.promo.codes.find(c => c.code === code);
  // Один и тот же ответ на «нет такого» и «выключен» — иначе перебором можно
  // выяснить, какие коды вообще существуют.
  if (!p || !p.active) return { ok: false, error: 'Промокод не найден' };
  if (p.usesLeft !== null && p.usesLeft <= 0) return { ok: false, error: 'Промокод уже использован' };
  if (p.minTotal && total < p.minTotal) {
    return { ok: false, error: `Промокод действует от ${money(p.minTotal, s)}` };
  }

  const raw = p.type === 'percent' ? Math.round(total * p.value / 100) : p.value;
  const discount = Math.max(0, Math.min(raw, total)); // скидка не больше суммы заказа
  return {
    ok: true, code: p.code, discount,
    total: total - discount,
    label: p.type === 'percent' ? `−${p.value}%` : `−${money(p.value, s)}`,
  };
}

// Списываем одно применение кода. Отдельно от расчёта: проверять можно сколько
// угодно раз, а тратить — только при реальном заказе.
function consumePromo(code) {
  const raw = store.read('settings', {});
  const list = (raw.promo && raw.promo.codes) || [];
  const p = list.find(c => String(c.code || '').toUpperCase() === code);
  if (!p) return;
  p.used = (p.used || 0) + 1;
  if (p.usesLeft !== null && p.usesLeft !== undefined) p.usesLeft = Math.max(0, p.usesLeft - 1);
  store.write('settings', raw);
}

const money = (n, s) => {
  const v = Number(n).toLocaleString(s.advanced.locale || 'ru-RU');
  return s.commerce.currencyPosition === 'before' ? `${s.commerce.currency}${v}` : `${v} ${s.commerce.currency}`;
};

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
  const cls = [s.theme.grain && 'grain', s.theme.diagonal && 'diagonal',
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

  // Админка переехала в бота: обычному браузеру страница не отдаётся.
  // Исключений два — открыто внутри Telegram WebApp либо аварийный вход
  // ?token=<ADMIN_TOKEN> (для обслуживания, в документации не светится).
  // Настоящая защита всё равно на API: страница без токена ничего не может.
  if (rel === '/admin.html') {
    const inTelegram = /Telegram/i.test(String(req.headers['user-agent'] || ''));
    const q = new URL(req.url, 'http://localhost').searchParams;
    if (!inTelegram && !tokenOk(req, String(q.get('token') || ''))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
  }

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

    // index.html отдаём с уже подставленной темой — единственный файл, который
    // мы модифицируем на лету, поэтому он не стримится, а собирается в памяти
    // (70 КБ, это ничего не стоит).
    if (isIndex) {
      const s = getSettings();
      let html = await fsp.readFile(full, 'utf8');
      // Название магазина подставляем в разметку, а не только скриптом: иначе
      // и вкладка браузера, и шапка мини-аппа секунду показывают заглушку
      // «SHOP», прежде чем приедет /api/settings.
      html = html.replace('<title>SHOP</title>', `<title>${esc(s.brand.shopName)}</title>`);
      html = html.replace('</head>', bootThemeCSS(s) + '</head>');
      const buf = Buffer.from(html, 'utf8');
      const h = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ETag: etag };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding';
        const gz = zlib.gzipSync(buf, { level: 6 });
        res.writeHead(200, { ...h, 'Content-Length': gz.length });
        return res.end(gz);
      }
      res.writeHead(200, { ...h, 'Content-Length': buf.length });
      return res.end(buf);
    }

    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: etag };

    // Текстовые файлы сжимаем: index.html — это ~70 КБ разметки со стилями и
    // скриптом в одном файле, gzip срезает его примерно вчетверо. Картинки и
    // шрифты не трогаем — они уже сжаты, повторное сжатие только греет процессор.
    if (TEXTUAL.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      return fs.createReadStream(full).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ---------- заказы ----------
function buildOrderText(s, items, c, tgUser, promo, finalTotal) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const total = finalTotal === undefined ? subtotal : finalTotal;
  const L = [];
  L.push('🛒 <b>Новый заказ</b>');
  L.push('');
  L.push(`👤 Клиент: ${esc(c.name || (tgUser && tgUser.first_name) || 'Без имени')}`);
  if (c.phone) L.push(`📱 Телефон: ${esc(c.phone)}`);
  if (c.email) L.push(`✉️ Email: ${esc(c.email)}`);
  if (c.address) L.push(`📍 Адрес: ${esc(c.address)}`);
  if (c.delivery) L.push(`🚚 Доставка: ${esc(c.delivery)}`);
  if (c.payment) L.push(`💳 Оплата: ${esc(c.payment)}`);
  if (c.comment) L.push(`📝 Комментарий: ${esc(c.comment)}`);
  L.push('');
  L.push('📦 <b>Товары:</b>');
  items.forEach(i => L.push(`• ${esc(i.name)} × ${i.qty} = ${money(i.price * i.qty, s)}`));
  L.push('');
  if (promo) {
    L.push(`Сумма: ${money(subtotal, s)}`);
    L.push(`🏷 Промокод <code>${esc(promo.code)}</code> (${esc(promo.label)}): −${money(promo.discount, s)}`);
  }
  L.push(`💰 <b>Итого: ${money(total, s)}</b>`);
  L.push(`🕒 ${new Date().toLocaleString(s.advanced.locale, { timeZone: s.advanced.timezone })}`);
  if (s.notify.includeCustomerLink && tgUser) {
    L.push(tgUser.username ? `💬 <a href="https://t.me/${esc(tgUser.username)}">@${esc(tgUser.username)}</a>` : `💬 id: <code>${tgUser.id}</code>`);
  }
  return { text: L.join('\n'), total };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // ===== публичное =====
  if (p === '/api/settings' && method === 'GET') {
    return json(res, 200, publicSettings(getSettings()));
  }

  if (p === '/api/products' && method === 'GET') {
    const s = getSettings();
    // Скрытые товары не отдаём вообще. Раньше их прятала только витрина, а сам
    // список был публичным: название и цену неопубликованного товара можно было
    // прочитать в /api/products, да и заказать его тоже.
    let list = store.read('products', []).filter(x => !x.hidden);
    if (s.catalog.hideSoldOut) list = list.filter(x => x.stock !== 0);
    return json(res, 200, list);
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
    const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
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
    const products = store.read('products', []);

    const items = (body.items || []).map(i => {
      // hidden — товар снят с витрины: заказать его нельзя даже по прямой ссылке
      const prod = products.find(x => x.id === Number(i.id) && !x.hidden);
      if (!prod) return null;
      const qty = Math.max(1, Math.min(999, Number(i.qty) || 1));
      return { id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty };
    }).filter(Boolean);

    if (!items.length) return json(res, 400, { error: 'корзина пуста' });

    // Остатки проверяет сервер, а не только витрина. Витрина не даёт положить в
    // корзину больше, чем есть, но прямой запрос это обходил: заказ на
    // раскупленный товар принимался, а остаток гасился в ноль через Math.max —
    // продавец получал заказ на то, чего нет.
    for (const i of items) {
      const prod = products.find(x => x.id === i.id);
      if (!prod || typeof prod.stock !== 'number' || prod.stock >= i.qty) continue;
      return json(res, 400, {
        error: prod.stock === 0
          ? `«${prod.name}» раскуплен`
          : `«${prod.name}»: осталось ${prod.stock} шт.`,
      });
    }

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    if (s.commerce.minOrder && total < s.commerce.minOrder) {
      return json(res, 400, { error: `Минимальный заказ — ${money(s.commerce.minOrder, s)}` });
    }

    // Промокод пересчитываем здесь заново, а не берём скидку из запроса:
    // клиент мог бы прислать любую сумму. Если код за это время кончился —
    // заказ всё равно проходит, просто без скидки, и это видно в уведомлении.
    let promo = null;
    if (body.promoCode) {
      const r = applyPromo(s, body.promoCode, total);
      if (r.ok) promo = { code: r.code, discount: r.discount, label: r.label };
    }
    const finalTotal = total - (promo ? promo.discount : 0);

    const c = body.customer || {};
    // Обязательный телефон проверяем и здесь: на витрине это валидация формы,
    // а сервер принимал заказ без контакта, до которого потом не дозвониться.
    // Порог в 10 цифр — тот же, что в форме, чтобы правила не разъезжались.
    if (s.checkout.askPhone && s.checkout.phoneRequired &&
        String(c.phone || '').replace(/\D/g, '').length < 10) {
      return json(res, 400, { error: 'Укажите телефон' });
    }
    const built = buildOrderText(s, items, c, tgUser, promo, finalTotal);
    let text = built.text;
    if (!tgUser) text += '\n\n⚠️ <i>Заказ оформлен вне Telegram — личность не подтверждена</i>';

    const order = {
      id: Date.now(),
      at: new Date().toISOString(),
      items, total: finalTotal, subtotal: total, promo, customer: c,
      user: tgUser ? { id: tgUser.id, username: tgUser.username || '', name: tgUser.first_name || '' } : null,
      status: 'new',
    };
    if (promo) consumePromo(promo.code);
    ordersRepo.add(order);

    // списываем остатки, если они заданы
    let changed = false;
    for (const i of items) {
      const prod = products.find(x => x.id === i.id);
      if (prod && typeof prod.stock === 'number') { prod.stock = Math.max(0, prod.stock - i.qty); changed = true; }
    }
    if (changed) store.write('products', products);

    if (s.notify.enabled && s.notify.onOrder) {
      // Ошибки доставки логирует сам notifyManagers ([notify] ...)
      await bot.notifyManagers(s, text).catch(e => console.error('[checkout] notifyManagers:', e.message));
    }
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
    return json(res, 200, { ok: true, orderId: order.id, total: finalTotal, orderText: built.text.replace(/<[^>]+>/g, '') });
  }

  // Создание платежа по уже оформленному заказу. Сумму берём из сохранённого
  // заказа, а не из запроса — иначе её можно было бы занизить до рубля.
  if (p === '/api/pay' && method === 'POST') {
    if (!rateLimit(ip, 10, 60000)) return json(res, 429, { error: 'слишком много запросов' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }

    const s = getSettings();
    if (!s.payments.enabled) return json(res, 400, { error: 'онлайн-оплата выключена' });

    const order = ordersRepo.find(body.orderId);
    if (!order) return json(res, 404, { error: 'заказ не найден' });
    if (order.paid) return json(res, 400, { error: 'заказ уже оплачен' });

    const provider = payments.getProvider(s.payments.provider);
    if (!provider) return json(res, 400, { error: 'платёжный провайдер не настроен' });

    // Одноразовый ключ на возврат из платёжного сервиса. Мерчант приводит
    // покупателя обратно на PUBLIC_URL/?paid=<id>&t=<ключ>, и витрина по нему
    // спрашивает у нас настоящий статус. Без ключа адрес был бы оракулом:
    // номера заказов — это Date.now(), их легко перебрать и узнать, кто и что
    // оплатил. Ключ живёт в самом заказе и наружу больше нигде не появляется.
    const returnToken = order.returnToken || crypto.randomBytes(16).toString('hex');

    let result;
    try {
      result = await provider.createPayment(s.payments.creds, order, {
        currencyCode: s.payments.currencyCode,
        publicUrl: tenant.publicUrl,
        returnToken,
      });
    } catch (e) {
      console.error('[pay] createPayment failed:', e.message);
      return json(res, 502, { error: 'платёжный сервис недоступен, попробуйте позже' });
    }
    if (!result.ok) return json(res, 502, { error: result.error || 'не удалось создать платёж' });

    ordersRepo.update(order.id, {
      returnToken,
      payment: { provider: s.payments.provider, externalId: result.externalId, at: new Date().toISOString() },
    });
    return json(res, 200, { ok: true, url: result.url, manual: !!result.manual });
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
  // что человек действительно из Telegram, а ADMIN_CHAT_IDS решает, владелец ли он.
  // Ответ на «не тот» и «не из списка» одинаковый — перебором список не выяснить.
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
    if (!user || !ADMIN_CHAT_IDS.includes(Number(user.id))) {
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
        const next = sanitize(mergeDeep(store.read('settings', {}), body));
        store.write('settings', next);
        return json(res, 200, next);
      }
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
        botConnected: !!BOT_TOKEN,
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

      add('token', 'Токен бота задан', !!BOT_TOKEN,
        BOT_TOKEN ? 'BOT_TOKEN прочитан из .env' : 'BOT_TOKEN пуст',
        'Впишите токен от @BotFather в /opt/tg-shop/.env и перезапустите: systemctl restart tg-shop');

      if (BOT_TOKEN) {
        const me = await tgApi('getMe', {}, { retries: 0, timeoutMs: 12000 });
        if (me.ok) {
          add('api', `Связь с Telegram (@${me.result.username})`, true, `API: ${API_BASE}`, '');
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

      add('publicUrl', 'PUBLIC_URL настроен', /^https:\/\//i.test(tenant.publicUrl),
        tenant.publicUrl || 'не задан',
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

      return json(res, 200, { checks, apiBase: API_BASE, botMode: tenant.botMode || 'polling' });
    }

    if (p === '/api/admin/payment-providers' && method === 'GET') {
      return json(res, 200, payments.providerSchema());
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
      const publicBase = tenant.publicUrl;
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

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[http]', req.method, url.pathname, e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] http://${HOST}:${PORT}  (данные: ${store.DATA_DIR})`);
  bot.start();
  backup.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { bot.stop(); backup.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
