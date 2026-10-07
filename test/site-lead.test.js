// Заявка с сайта магазина → бот → получатели уведомлений. Живой сервер против
// заглушки Bot API: проверяем ключ, кому уходит сообщение и что в нём.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const PORT = 5200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'site-key-' + Math.random().toString(36).slice(2);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-sitelead-'));
const calls = [];
let stub;
let child;

const lead = (body, key = KEY) => fetch(BASE + '/api/inbound-lead', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Site-Token': key } : {}) },
  body: JSON.stringify(body),
});
const settle = () => new Promise(r => setTimeout(r, 50));
const sentSince = mark => calls.slice(mark).filter(c => c.method === 'sendMessage');

function writeSettings(notify) {
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ notify }));
}

test.before(async () => {
  stub = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      const method = (rq.url.match(/^\/bot[^/]+\/(.+)$/) || [])[1];
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ method, body });
      rs.setHeader('Content-Type', 'application/json');
      if (method === 'getMe') return rs.end(JSON.stringify({ ok: true, result: { id: 1, username: 'test_shop_bot' } }));
      rs.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));

  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), '[]');
  fs.writeFileSync(path.join(DATA_DIR, 'admins.json'), JSON.stringify({ owners: [{ id: 777 }] }));
  writeSettings({ enabled: true, chatIds: ['555', '-100200'] });

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_TOKEN: 'adm-' + KEY, DATA_DIR,
      BOT_TOKEN: '123:TEST', TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      // вебхук без https и без отката — бот не опрашивает заглушку, но отправлять умеет
      BOT_MODE: 'webhook', BOT_STRICT_WEBHOOK: '1', PUBLIC_URL: '', SITE_LEAD_TOKEN: KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (e) { /* ждём */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
});

test.after(() => {
  if (child) child.kill();
  if (stub) stub.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('без ключа и с чужим ключом — отказ, сообщений нет', async () => {
  const mark = calls.length;
  assert.strictEqual((await lead({ contact: '+79990000000' }, '')).status, 401);
  assert.strictEqual((await lead({ contact: '+79990000000' }, 'wrong')).status, 401);
  await settle();
  assert.strictEqual(sentSince(mark).length, 0);
});

const admin = (p, opts = {}) => fetch(BASE + p, {
  ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'adm-' + KEY, ...(opts.headers || {}) },
});

test('заявка уходит админам бота, с кнопками и ссылкой на товар', async () => {
  const mark = calls.length;
  const r = await lead({
    type: 'tradein', name: '<b>Олег</b>', contact: '@oleg_buyer', product: 'iPhone 15 Pro', price: '104 990 ₽',
    message: 'Сдам 13 Pro\nв хорошем состоянии', url: 'https://site.example/p/iphone-15-pro-t1',
    adminUrl: 'https://site.example/admin#leads', site: 'site.example',
  });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.deepStrictEqual([d.ok, d.sent, d.total, d.to], [true, 1, 1, 'admins']);
  const sent = sentSince(mark);
  assert.deepStrictEqual(sent.map(c => c.body.chat_id), [777], 'админу, а не в чат уведомлений о заказах');
  const m = sent[0].body;
  assert.match(m.text, /Заявка с сайта · Trade-in/);
  assert.match(m.text, /&lt;b&gt;Олег/, 'имя экранировано');
  assert.match(m.text, /<a href="https:\/\/t\.me\/oleg_buyer">@oleg_buyer<\/a>/);
  assert.match(m.text, /<a href="https:\/\/site\.example\/p\/iphone-15-pro-t1">iPhone 15 Pro<\/a> — 104 990 ₽/);
  assert.match(m.text, /Сдам 13 Pro\nв хорошем состоянии/, 'переносы в сообщении сохранены');
  assert.deepStrictEqual(m.reply_markup.inline_keyboard[0].map(b => b.text), ['💬 Написать клиенту', 'Все заявки']);
});

test('проверка связи и пустая заявка', async () => {
  const mark = calls.length;
  const t = await (await lead({ test: true, site: 'site.example' })).json();
  assert.deepStrictEqual([t.ok, t.to], [true, 'admins']);
  assert.match(sentSince(mark)[0].body.text, /Проверка связи с сайтом/);
  assert.strictEqual((await lead({ name: 'x' })).status, 502, 'без контакта не рассылаем');
});

test('админов нет — заявка уходит получателям уведомлений о заказах', async () => {
  assert.strictEqual((await admin('/api/admin/owners/777', { method: 'DELETE' })).status, 200);
  const mark = calls.length;
  const d = await (await lead({ contact: '+7 999 000-00-00', product: 'iPad' })).json();
  assert.deepStrictEqual([d.ok, d.to], [true, 'managers']);
  const sent = sentSince(mark);
  assert.deepStrictEqual(sent.map(c => String(c.body.chat_id)).sort(), ['-100200', '555']);
  assert.match(sent[0].body.text, /<code>\+7 999 000-00-00<\/code>/, 'телефон — моноширинным, удобно копировать');
  assert.strictEqual(sent[0].body.reply_markup, undefined, 'без username кнопки «написать» нет');
});

test('ни админов, ни получателей — честная ошибка, а не тишина', async () => {
  const put = await admin('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ notify: { enabled: false } }) });
  assert.strictEqual(put.status, 200);
  const r = await lead({ contact: '@someone_x' });
  assert.strictEqual(r.status, 502);
  assert.match((await r.json()).error, /\/owner/);
});
