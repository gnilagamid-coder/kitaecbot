'use strict';
// Сквозной тест: поднимаем настоящий сервер на свободном порту с временной
// папкой данных и ходим по нему как клиент. Ловит то, что модульные тесты
// не видят, — разводку ручек, коды ответов и защиту админки.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-smoke-'));

let child;

const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const admin = (p, opts = {}) => api(p, { ...opts, headers: { 'x-admin-token': TOKEN, ...(opts.headers || {}) } });

test.before(async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), JSON.stringify([
    { id: 1, name: 'Кружка', price: 500, stock: 10, images: [], thumbs: [] },
    { id: 2, name: 'Скрытый', price: 100, hidden: true, stock: null, images: [], thumbs: [] },
    { id: 3, name: 'Раскупленный', price: 700, stock: 0, images: [], thumbs: [] },
  ]));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, DATA_DIR, BOT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));

  // ждём, пока порт начнёт отвечать
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

test('healthz отвечает без запуска Telegram и базы', async () => {
  const r = await api('/healthz');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true });
});

test('витрина не отдаёт скрытые товары', async () => {
  const list = await (await api('/api/products')).json();
  assert.ok(list.find(p => p.id === 1), 'обычный товар должен быть');
  assert.strictEqual(list.find(p => p.id === 2), undefined, 'скрытый наружу не отдаётся');
});

test('заказ раскупленного товара отклоняется', async () => {
  const r = await api('/api/checkout', {
    method: 'POST',
    body: JSON.stringify({ items: [{ id: 3, qty: 1 }], customer: { name: 'Тест' } }),
  });
  assert.strictEqual(r.status, 400);
});

test('заказ проходит и списывает остаток', async () => {
  const r = await api('/api/checkout', {
    method: 'POST',
    body: JSON.stringify({ items: [{ id: 1, qty: 2 }], customer: { name: 'Пётр', phone: '+79990000000' } }),
  });
  const d = await r.json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.total, 1000);

  const list = await (await api('/api/products')).json();
  assert.strictEqual(list.find(p => p.id === 1).stock, 8);
});

test('админ видит заказ, статусы и счётчики', async () => {
  const d = await (await admin('/api/admin/orders')).json();
  assert.strictEqual(d.total, 1);
  assert.strictEqual(d.items[0].status, 'new');
  assert.ok(Array.isArray(d.statuses) && d.statuses.length > 0);
  assert.strictEqual(d.counts.new, 1);
});

test('статус заказа меняется и переживает перечитывание', async () => {
  const before = await (await admin('/api/admin/orders')).json();
  const id = before.items[0].id;

  const r = await admin('/api/admin/orders', { method: 'PATCH', body: JSON.stringify({ id, status: 'shipped' }) });
  assert.strictEqual(r.status, 200);

  const after = await (await admin('/api/admin/orders')).json();
  assert.strictEqual(after.items[0].status, 'shipped');
  assert.strictEqual(after.counts.shipped, 1);
});

test('несуществующий статус не принимается', async () => {
  const before = await (await admin('/api/admin/orders')).json();
  const r = await admin('/api/admin/orders', {
    method: 'PATCH',
    body: JSON.stringify({ id: before.items[0].id, status: 'что-нибудь' }),
  });
  assert.strictEqual(r.status, 400);
});

test('CSV отдаётся файлом и открывается в Excel', async () => {
  const r = await admin('/api/admin/orders/export.csv');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"/);
  // Читаем именно байты: fetch.text() по спецификации срезает BOM при
  // декодировании UTF-8, и проверка по строке всегда была бы ложно-зелёной.
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepStrictEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf],
    'BOM обязателен, иначе Excel открывает UTF-8 как cp1251');
  const body = Buffer.from(bytes).toString('utf8');
  assert.ok(body.includes('Пётр'), 'данные заказа должны попасть в выгрузку');
});

test('статистика считает заказы и выручку', async () => {
  const s = await (await admin('/api/admin/stats')).json();
  assert.strictEqual(s.orders, 1);
  assert.strictEqual(s.revenue, 1000);
  assert.strictEqual(s.ordersByStatus.shipped, 1);
});

test('статус оплаты без ключа не отдаётся', async () => {
  const before = await (await admin('/api/admin/orders')).json();
  const id = before.items[0].id;
  assert.strictEqual((await api(`/api/pay/status?id=${id}`)).status, 404);
  assert.strictEqual((await api(`/api/pay/status?id=${id}&t=${encodeURIComponent('подделка')}`)).status, 404);
  assert.strictEqual((await api('/api/pay/status?id=999999&t=x')).status, 404);
});

// Этот тест идёт последним намеренно: он блокирует 127.0.0.1 для админки,
// и всё, что стояло бы после него, получало бы 429.
test('превью чат-бота: только для админа, на присланных настройках', async () => {
  const anon = await api('/api/admin/chatbot-preview', { method: 'POST', body: JSON.stringify({ settings: {} }) });
  assert.ok([401, 403, 429].includes(anon.status), `без токена превью не отдаётся (статус ${anon.status})`);

  const r = await admin('/api/admin/chatbot-preview', {
    method: 'POST',
    body: JSON.stringify({ settings: { chatbot: { buttons: { catalog: 'Витрина' } } } }),
  });
  assert.strictEqual(r.status, 200);
  const p = await r.json();
  assert.strictEqual(p.keyboard.keyboard[0][0].text, 'Витрина');
  assert.ok(p.home && p.catalog && p.cart && p.help);

  // превью ничего не сохраняет
  const saved = await (await admin('/api/admin/settings')).json();
  assert.notStrictEqual(saved.chatbot.buttons.catalog, 'Витрина');
});

// Перебор пароля ставит IP на паузу для всех запросов к админке — поэтому он
// идёт последним из админских проверок.
test('перебор пароля упирается в паузу', async () => {
  let sawLock = false;
  let status = 0;
  for (let i = 0; i < 12; i++) {
    const r = await api('/api/admin/stats', { headers: { 'x-admin-token': 'wrong-token' } });
    status = r.status;
    if (r.status === 429) {
      assert.ok(r.headers.get('retry-after'), 'должен быть заголовок Retry-After');
      sawLock = true;
      break;
    }
    assert.strictEqual(r.status, 401, `попытка ${i + 1} должна отвергаться как 401`);
  }
  assert.ok(sawLock, `после серии неудач должен приходить 429, а пришёл ${status}`);

  // и правильный токен теперь тоже ждёт — иначе пауза обходится за один запрос
  const withGoodToken = await admin('/api/admin/stats');
  assert.strictEqual(withGoodToken.status, 429);
});

