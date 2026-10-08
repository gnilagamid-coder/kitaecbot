// Витрина — внешний сайт (SITE_URL): кнопки бота ведут на сайт, панель — в его
// админку, кнопочного каталога в чате нет; сайт спрашивает у бота, владелец ли
// человек из Mini App (/api/site/tg-auth). Живой сервер против заглушки Bot API.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const PORT = 5500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'site-key-' + Math.random().toString(36).slice(2);
const BOT_TOKEN = '123:SITE-MODE';
const ADMIN_TOKEN = 'adm-' + KEY;
const SITE = 'https://site.example.test';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-sitemode-'));
const SECRET = crypto.createHash('sha256').update(`${BOT_TOKEN}|${ADMIN_TOKEN}|${ADMIN_TOKEN}|`).digest('hex').slice(0, 48);
const calls = [];
let stub;
let child;

function makeInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAF-site');
  params.set('user', JSON.stringify(user));
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const tgAuth = (initData, key = KEY) => fetch(BASE + '/api/site/tg-auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Site-Token': key } : {}) },
  body: JSON.stringify({ initData }),
});
const update = (id, text) => fetch(BASE + '/api/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
  body: JSON.stringify({
    update_id: Date.now(),
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private', first_name: 'Гость' }, from: { id, is_bot: false, first_name: 'Гость' }, text },
  }),
});
async function waitFor(cond, ms = 5000) {
  for (let t = 0; t < ms; t += 50) {
    const v = cond();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('не дождался');
}
const sentTo = (id, mark) => calls.slice(mark).filter(c => c.method === 'sendMessage' && c.body.chat_id === id);

test.before(async () => {
  stub = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      const method = (rq.url.match(/^\/bot[^/]+\/(.+)$/) || [])[1];
      calls.push({ method, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      rs.setHeader('Content-Type', 'application/json');
      if (method === 'getMe') return rs.end(JSON.stringify({ ok: true, result: { id: 1, username: 'site_shop_bot' } }));
      rs.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));

  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), '[]');
  fs.writeFileSync(path.join(DATA_DIR, 'admins.json'), JSON.stringify({ owners: [{ id: 777, name: 'Владелец' }] }));
  // кнопочный магазин был включён — с сайтом он должен молчать
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ bot: { enabled: true, classicMenu: true } }));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_TOKEN, DATA_DIR, BOT_TOKEN,
      TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      BOT_MODE: 'webhook', BOT_STRICT_WEBHOOK: '1', PUBLIC_URL: 'https://shop.example.test',
      SITE_LEAD_TOKEN: KEY, SITE_URL: SITE + '/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitFor(() => calls.some(c => c.method === 'setWebhook'), 8000);
});

test.after(() => {
  if (child) child.kill();
  if (stub) stub.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('кнопка меню открывает сайт', async () => {
  const mb = await waitFor(() => calls.find(c => c.method === 'setChatMenuButton'));
  assert.strictEqual(mb.body.menu_button.type, 'web_app');
  assert.strictEqual(mb.body.menu_button.web_app.url, SITE, 'адрес сайта без хвостового /');
});

test('/start: кнопка «Открыть магазин» — сайт, клавиатуры кнопочного магазина нет', async () => {
  const mark = calls.length;
  assert.strictEqual((await update(4242, '/start')).status, 200);
  const [msg] = await waitFor(() => { const l = sentTo(4242, mark); return l.length ? l : null; });
  const rows = msg.body.reply_markup.inline_keyboard;
  assert.strictEqual(rows[0][0].web_app.url, SITE);
  assert.ok(!msg.body.reply_markup.keyboard, 'без нижней клавиатуры каталога');
});

test('старая кнопка каталога: клавиатура убирается, вместо неё — сайт', async () => {
  const mark = calls.length;
  await update(4243, '🛍 Каталог');
  const list = await waitFor(() => { const l = sentTo(4243, mark); return l.length >= 2 ? l : null; });
  assert.deepStrictEqual(list[0].body.reply_markup, { remove_keyboard: true });
  assert.strictEqual(list[1].body.reply_markup.inline_keyboard[0][0].web_app.url, SITE);
});

test('/admin владельца: панель — админка сайта', async () => {
  const mark = calls.length;
  await update(777, '/admin');
  const [msg] = await waitFor(() => { const l = sentTo(777, mark); return l.length ? l : null; });
  assert.strictEqual(msg.body.reply_markup.inline_keyboard[0][0].web_app.url, `${SITE}/admin`);
});

test('tg-auth: ключ сайта обязателен', async () => {
  const init = makeInitData({ id: 777, first_name: 'Ара' });
  assert.strictEqual((await tgAuth(init, '')).status, 401);
  assert.strictEqual((await tgAuth(init, 'wrong')).status, 401);
});

test('tg-auth: владелец — да, чужой и подделка — нет, отказы не запирают сайт', async () => {
  const ok = await tgAuth(makeInitData({ id: 777, first_name: 'Ара', last_name: 'К', username: 'araik' }));
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual((await ok.json()).user, { id: 777, name: 'Ара К', username: 'araik' });

  for (let i = 0; i < 8; i++) {
    assert.strictEqual((await tgAuth(makeInitData({ id: 999, first_name: 'Чужой' }))).status, 403);
  }
  const forged = makeInitData({ id: 777 }).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.strictEqual((await tgAuth(forged)).status, 403);
  const old = makeInitData({ id: 777 }, Math.floor(Date.now() / 1000) - 2 * 86400);
  assert.strictEqual((await tgAuth(old)).status, 403, 'старше суток — нет');
  assert.strictEqual((await tgAuth(makeInitData({ id: 777 }))).status, 200, 'после чужих отказов владелец входит');
});
