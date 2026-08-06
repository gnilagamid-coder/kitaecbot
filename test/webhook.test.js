// Webhook-режим end-to-end: бот регистрирует вебхук у Telegram и принимает
// апдейты по HTTP. Настоящий Telegram подменён стабом API (getMe/setWebhook/
// sendMessage), зато путь проверяется целиком: регистрация, секрет в заголовке,
// доставка апдейта и ответ пользователю. Плюс строгий режим: с
// BOT_STRICT_WEBHOOK=1 бот не откатывается на long polling.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BOT_TOKEN = '777:test-token';
const ADMIN_TOKEN = 'secret-admin-token';
const PORT = 5500 + Math.floor(Math.random() * 300);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-webhook-'));

// Секрет вебхука считается так же, как в bot.js: токен + ключ сессий + пароль
// админки + id магазина. В одиночной установке id пуст, ключ сессий = пароль.
const SECRET = crypto.createHash('sha256')
  .update(`${BOT_TOKEN}|${ADMIN_TOKEN}|${ADMIN_TOKEN}|`)
  .digest('hex')
  .slice(0, 48);

// ---------- стаб Telegram Bot API ----------
const calls = []; // { method, body }
let stub, stubPort;

test.before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const m = req.url.match(/^\/bot[^/]+\/(.+)$/);
      const method = m ? m[1] : req.url;
      calls.push({ method, body });
      res.setHeader('Content-Type', 'application/json');
      if (method === 'getMe') {
        return res.end(JSON.stringify({ ok: true, result: { id: 777, is_bot: true, first_name: 'Stub', username: 'stub_bot' } }));
      }
      if (method === 'sendMessage') {
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }));
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
});

test.after(async () => {
  if (stub) stub.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------- запуск настоящего сервера против стаба ----------
let child;
const lines = [];

function spawnShop(env) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      BOT_TOKEN, ADMIN_TOKEN, ADMIN_CHAT_IDS: '',
      DATA_DIR,
      BOT_MODE: 'webhook', BOT_STRICT_WEBHOOK: '1',
      TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', d => lines.push(String(d)));
  c.stderr.on('data', d => lines.push(String(d)));
  return c;
}

function waitFor(cond, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('не дождался условия; журнал:\n' + lines.join('')));
      setTimeout(tick, 100);
    })();
  });
}

function post(pathname, { headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const update = {
  update_id: 1,
  message: {
    message_id: 1, date: Math.floor(Date.now() / 1000),
    chat: { id: 424242, type: 'private', first_name: 'Покупатель' },
    from: { id: 424242, is_bot: false, first_name: 'Покупатель' },
    text: '/start',
  },
};

test('webhook: регистрация, секрет и доставка апдейта end-to-end', async () => {
  child = spawnShop({ PUBLIC_URL: 'https://shop.example.test' });
  await waitFor(() => lines.some(l => l.includes('[web]')));

  // 1. Бот сам зарегистрировал вебхук на PUBLIC_URL/api/webhook
  await waitFor(() => calls.some(c => c.method === 'setWebhook'));
  const wh = calls.find(c => c.method === 'setWebhook');
  assert.strictEqual(wh.body.url, 'https://shop.example.test/api/webhook');
  assert.strictEqual(wh.body.secret_token, SECRET, 'Telegram получит секрет и будет им подписывать апдейты');
  await waitFor(() => lines.some(l => l.includes('режим: webhook')));

  // 2. Чужой запрос без правильного секрета отклоняется
  const bad = await post('/api/webhook', { body: update });
  assert.strictEqual(bad.status, 401, 'поддельный апдейт не принят');
  const badSig = await post('/api/webhook', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong'.repeat(8) }, body: update,
  });
  assert.strictEqual(badSig.status, 401);

  // 3. Апдейт от Telegram (с секретом) обрабатывается: бот отвечает на /start
  const ok = await post('/api/webhook', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: update,
  });
  assert.strictEqual(ok.status, 200);
  await waitFor(() => calls.some(c => c.method === 'sendMessage' && c.body.chat_id === 424242), 5000);
  const reply = calls.find(c => c.method === 'sendMessage' && c.body.chat_id === 424242);
  assert.ok(String(reply.body.text || '').length > 0, 'приветствие отправлено');

  // 4. Опроса нет: вебхук и getUpdates взаимоисключающи
  assert.ok(!calls.some(c => c.method === 'getUpdates'), 'в вебхук-режиме бот не опрашивает Telegram');

  await new Promise(resolve => { child.on('exit', resolve); child.kill(); });
});

test('webhook strict: без HTTPS бот не запущен, откат на polling запрещён', async () => {
  lines.length = 0;
  calls.length = 0;
  child = spawnShop({ PUBLIC_URL: 'http://shop.example.test' }); // не https
  await waitFor(() => lines.some(l => l.includes('[web]')));
  await waitFor(() => lines.some(l => l.includes('откат на polling запрещён')));

  // Дадим время возможному (запрещённому) откату — опрос так и не начнётся
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(!calls.some(c => c.method === 'getUpdates'), 'strict-режим не скатился в опрос');
  assert.ok(!calls.some(c => c.method === 'setWebhook'), 'не-HTTPS адрес не зарегистрирован');

  await new Promise(resolve => { child.on('exit', resolve); child.kill(); });
});
