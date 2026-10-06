// Админка как Mini App из бота: вход — по initData Telegram для chat_id из
// ADMIN_CHAT_IDS, вместо вечного ADMIN_TOKEN страница получает подписанный
// билет на 30 дней. Аварийный вход — токен в поле формы, а не в URL
// (query-строки оседают в access-логах nginx и истории браузера).
// Сквозной тест на живом сервере (схема smoke.test.js). Сеть к Telegram
// не нужна: подпись initData считается локально тем же алгоритмом.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const PORT = 4200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const FAKE_BOT_TOKEN = '777:TEST-BOT-TOKEN';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-adminbot-'));
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36';
const TG_UA = 'Mozilla/5.0 (Linux) TelegramWebApp/10.5';

let child;

// Тело — Buffer: fetch со строкой требует ByteString, а Cyrillic-пароли
// в JSON без этого падали бы ещё до запроса.
const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  body: opts.body === undefined ? undefined : Buffer.from(opts.body),
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const admin = (p, opts = {}) => api(p, { ...opts, headers: { 'x-admin-token': TOKEN, ...(opts.headers || {}) } });

// initData, подписанный ровно тем же способом, что проверяет telegram.js:
// HMAC(HMAC(botToken, 'WebAppData'), строка проверки).
function makeInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAF-test');
  params.set('user', JSON.stringify(user));
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(FAKE_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const tgLogin = initData => api('/api/admin/tg-login', { method: 'POST', body: JSON.stringify({ initData }) });

test.before(async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), '[]');
  // владелец, добавленный через бота (/owner + пароль), — не из .env
  fs.writeFileSync(path.join(DATA_DIR, 'admins.json'), JSON.stringify({ owners: [{ id: 333, name: 'Компаньон' }] }));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      ADMIN_TOKEN: TOKEN, DATA_DIR,
      BOT_TOKEN: FAKE_BOT_TOKEN,      // подпись initData считается локально, сеть не нужна
      ADMIN_CHAT_IDS: '111, 222',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {}); // getMe фейк-токена ругается — это ожидаемо

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/settings'); return; } catch (e) { /* ещё не поднялся */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся за 6 секунд');
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('страница админки — лишь форма входа, токен в URL не участвует', async () => {
  // Страница доступна и браузеру, и Telegram: секретов в ней нет,
  // вся защита — на API. Раньше браузеру без ?token= приходил 404.
  const browser = await fetch(BASE + '/admin.html', { headers: { 'User-Agent': BROWSER_UA } });
  assert.strictEqual(browser.status, 200, 'форма входа открывается из браузера');
  assert.match(await browser.text(), /Вход в админку/);

  const tg = await fetch(BASE + '/admin.html', { headers: { 'User-Agent': TG_UA } });
  assert.strictEqual(tg.status, 200, 'внутри Telegram WebApp страница открывается');

  // ?token= в адресе больше ничего не решает: страница отдаётся та же самая,
  // а токен вводится только в поле формы и в логи/историю не попадает.
  const legacy = await fetch(`${BASE}/admin.html?token=${encodeURIComponent(TOKEN)}`, { headers: { 'User-Agent': BROWSER_UA } });
  assert.strictEqual(legacy.status, 200);

  // Настоящая защита на месте: API без токена закрыт.
  // (эта 401 учитывается счётчиком authguard — тесты дальше это допускают)
  assert.strictEqual((await api('/api/admin/stats')).status, 401);

  // витрина при этом открыта всем
  assert.strictEqual((await fetch(BASE + '/index.html', { headers: { 'User-Agent': BROWSER_UA } })).status, 200);
});

test('владелец из ADMIN_CHAT_IDS получает билет и входит в API', async () => {
  const r = await tgLogin(makeInitData({ id: 111, first_name: 'Owner', username: 'owner' }));
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.ok(d.token && d.token.startsWith('a1.111.'), 'билет привязан к chat_id');
  assert.strictEqual(d.name, 'Owner');

  const stats = await api('/api/admin/stats', { headers: { 'x-admin-token': d.token } });
  assert.strictEqual(stats.status, 200, 'билет работает вместо ADMIN_TOKEN');

  const second = await tgLogin(makeInitData({ id: 222, first_name: 'Second' }));
  assert.strictEqual(second.status, 200, 'второй id из списка тоже проходит');
});

// Идёт до серии неудачных попыток: они копятся в общем authguard на IP,
// и после пяти ошибок даже верный ADMIN_TOKEN ловил бы 429.
test('ADMIN_TOKEN по-прежнему работает (регрессия)', async () => {
  assert.strictEqual((await admin('/api/admin/stats')).status, 200);
});

// Тоже до серии неудач: в конце один честный 401 после отзыва доступа.
test('владелец, добавленный через бота, входит; отзыв в панели закрывает вход сразу', async () => {
  const login = await tgLogin(makeInitData({ id: 333, first_name: 'Компаньон' }));
  assert.strictEqual(login.status, 200, 'владелец из admins.json проходит');
  const ticket = (await login.json()).token;

  const list = await (await admin('/api/admin/owners')).json();
  assert.deepStrictEqual(list.owners.map(o => [o.id, o.source]), [[111, 'env'], [222, 'env'], [333, 'bot']]);

  // базового из .env панель не убирает
  assert.strictEqual((await admin('/api/admin/owners/111', { method: 'DELETE' })).status, 409);
  assert.strictEqual((await admin('/api/admin/owners/333', { method: 'DELETE' })).status, 200);
  assert.strictEqual((await admin('/api/admin/owners/333', { method: 'DELETE' })).status, 404);

  // выданный раньше билет больше не действует
  assert.strictEqual((await api('/api/admin/stats', { headers: { 'x-admin-token': ticket } })).status, 401);
  // удачный вход сбрасывает счётчик authguard — тестам ниже он нужен с нуля
  assert.strictEqual((await admin('/api/admin/stats')).status, 200);
});

test('чужой Telegram в админку не проходит', async () => {
  // id вне списка — тот же 401, без подсказок
  const stranger = await tgLogin(makeInitData({ id: 999, first_name: 'Stranger' }));
  assert.strictEqual(stranger.status, 401);

  // поддельная подпись — тоже 401
  const forged = makeInitData({ id: 111 }).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.strictEqual((await tgLogin(forged)).status, 401);

  // протухший initData (старше 24 часов) не принимается
  const stale = makeInitData({ id: 111 }, Math.floor(Date.now() / 1000) - 26 * 3600);
  assert.strictEqual((await tgLogin(stale)).status, 401);
});

test('подделанный и протухший билет в API не пускается', async () => {
  // билет на чужой ключ (не наш ADMIN_TOKEN)
  const badKey = (() => {
    const exp = Date.now() + 60000;
    const payload = `a1.111.${exp}`;
    return `${payload}.${crypto.createHmac('sha256', 'other-key').update(payload).digest('hex')}`;
  })();
  assert.strictEqual((await api('/api/admin/stats', { headers: { 'x-admin-token': badKey } })).status, 401);

  // просроченный билет
  const expired = (() => {
    const exp = Date.now() - 1000;
    const payload = `a1.111.${exp}`;
    return `${payload}.${crypto.createHmac('sha256', TOKEN).update(payload).digest('hex')}`;
  })();
  assert.strictEqual((await api('/api/admin/stats', { headers: { 'x-admin-token': expired } })).status, 401);

  // билет на id вне списка допуска — даже с верной подписью
  const unlisted = (() => {
    const exp = Date.now() + 60000;
    const payload = `a1.999.${exp}`;
    return `${payload}.${crypto.createHmac('sha256', TOKEN).update(payload).digest('hex')}`;
  })();
  assert.strictEqual((await api('/api/admin/stats', { headers: { 'x-admin-token': unlisted } })).status, 401);
});

// Последним намеренно: после серии неудач адрес сидит в паузе authguard.
test('перебор входа через tg-login упирается в паузу', async () => {
  let sawLock = false;
  for (let i = 0; i < 12; i++) {
    const r = await tgLogin(makeInitData({ id: 999 }));
    if (r.status === 429) {
      assert.ok(r.headers.get('retry-after'), 'должен быть заголовок Retry-After');
      sawLock = true;
      break;
    }
    assert.strictEqual(r.status, 401, `попытка ${i + 1} должна отвергаться как 401`);
  }
  assert.ok(sawLock, 'после серии неудач должен приходить 429');
});
