// Витрина — сайт магазина (SITE_URL): кнопки бота ведут на сайт, панель — в его
// админку; кнопочный магазин в чате работает как раньше, но товары берёт с
// сайта, а заказы из корзины отправляет туда же. Сайт спрашивает у бота,
// владелец ли человек из Mini App (/api/site/tg-auth). Живой сервер против
// заглушек Bot API и сайта.

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
const siteHits = [];
let stub;
let site;
let child;

// Лента сайта: две комплектации модели и свой товар
const FEED = {
  brand: 'JokerPhone', currency: '₽',
  items: [
    { key: 'm|galaxy-s26-ultra|black|12-256', name: 'Galaxy S26 Ultra 12/256 ГБ чёрный', category: 'Galaxy S26 Ultra', price: 79990, oldPrice: 89990, status: 'available', description: 'В наличии', image: '/tg-img/galaxy-s26-ultra/black.webp', url: '/galaxy/s26-ultra/black-12-256', featured: true },
    { key: 'm|galaxy-s26-ultra|black|12-512', name: 'Galaxy S26 Ultra 12/512 ГБ чёрный', category: 'Galaxy S26 Ultra', price: 96990, oldPrice: null, status: 'order', description: 'Под заказ, срок 1–3 дня', image: '/tg-img/galaxy-s26-ultra/black.webp', url: '/galaxy/s26-ultra/black-12-512', featured: false },
    { key: 'p|a3aedefb', name: 'iPad Pro 11 M5 256 ГБ', category: 'iPad', price: 150000, oldPrice: 200000, status: 'available', description: 'В наличии', image: '/media/711bf8b84f060749d8dab06621750765.webp', url: '/p/ipad-pro-11-m5-256-gb-a3aedefb', featured: false },
  ],
};
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00', 'binary');

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
async function waitFor(cond, ms = 6000) {
  for (let t = 0; t < ms; t += 50) {
    const v = cond();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('не дождался');
}
const sentTo = (id, mark) => calls.slice(mark).filter(c => /^send(Message|Photo)$/.test(c.method) && String(c.body.chat_id) === String(id));
const products = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'products.json'), 'utf8')); } catch (e) { return []; } };

test.before(async () => {
  // Bot API: JSON-вызовы и multipart-загрузки фото
  stub = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      const method = (rq.url.match(/^\/bot[^/]+\/(.+)$/) || [])[1];
      const raw = Buffer.concat(chunks).toString('latin1');
      let body = {};
      if (/multipart/.test(rq.headers['content-type'] || '')) {
        for (const m of raw.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) body[m[1]] = m[2];
        body.upload = true;
      } else body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ method, body });
      rs.setHeader('Content-Type', 'application/json');
      if (method === 'getMe') return rs.end(JSON.stringify({ ok: true, result: { id: 1, username: 'site_shop_bot' } }));
      if (method === 'sendPhoto') return rs.end(JSON.stringify({ ok: true, result: { message_id: 2, photo: [{ file_id: 'ph1' }] } }));
      rs.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));

  // сайт: лента с ETag, картинки, приём заказов
  site = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      siteHits.push({ url: rq.url, key: rq.headers['x-site-token'], body: Buffer.concat(chunks).toString() });
      if (rq.url.startsWith('/api/bot/')) {
        if (rq.headers['x-site-token'] !== KEY) { rs.writeHead(401); return rs.end('{}'); }
        if (rq.url === '/api/bot/order') { rs.writeHead(201); return rs.end('{"ok":true}'); }
        if (rq.headers['if-none-match'] === '"v1"') { rs.writeHead(304); return rs.end(); }
        rs.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' });
        return rs.end(JSON.stringify(FEED));
      }
      if (/^\/(tg-img|media)\//.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'image/webp' }); return rs.end(WEBP); }
      rs.writeHead(404);
      rs.end();
    });
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));

  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  // старый ботовый товар: после синхронизации каталога его быть не должно
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), JSON.stringify([{ id: 1, name: 'Старый товар бота', price: 1000, category: 'Разное', images: [] }]));
  fs.writeFileSync(path.join(DATA_DIR, 'images', 'site_stale0000000000000000.webp'), WEBP);
  fs.writeFileSync(path.join(DATA_DIR, 'admins.json'), JSON.stringify({ owners: [{ id: 777, name: 'Владелец' }] }));
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ bot: { enabled: true, classicMenu: true } }));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_TOKEN, DATA_DIR, BOT_TOKEN,
      TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      BOT_MODE: 'webhook', BOT_STRICT_WEBHOOK: '1', PUBLIC_URL: 'https://shop.example.test',
      SITE_LEAD_TOKEN: KEY, SITE_URL: SITE + '/', SITE_API_URL: `http://127.0.0.1:${site.address().port}`,
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
  if (site) site.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('кнопка меню открывает сайт', async () => {
  const mb = await waitFor(() => calls.find(c => c.method === 'setChatMenuButton'));
  assert.strictEqual(mb.body.menu_button.type, 'web_app');
  assert.strictEqual(mb.body.menu_button.web_app.url, SITE, 'адрес сайта без хвостового /');
});

test('каталог бота — с сайта: комплектации и свои товары, картинки скачаны, старое убрано', async () => {
  const list = await waitFor(() => { const l = products(); return l.length === 3 ? l : null; });
  assert.ok(!list.some(p => p.name === 'Старый товар бота'));
  const s26 = list.find(p => p.siteKey === 'm|galaxy-s26-ultra|black|12-256');
  assert.strictEqual(s26.category, 'Galaxy S26 Ultra', 'раздел в чате — модель');
  assert.strictEqual(s26.price, 79990);
  assert.strictEqual(s26.oldPrice, 89990);
  assert.strictEqual(s26.featured, true);
  assert.strictEqual(s26.siteUrl, `${SITE}/galaxy/s26-ultra/black-12-256`, 'ссылка в мини-апп — публичный адрес');
  assert.ok(Number.isSafeInteger(s26.id));
  const order = list.find(p => p.siteKey.endsWith('12-512'));
  assert.strictEqual(order.badge, 'Под заказ');
  assert.deepStrictEqual(order.images, s26.images, 'картинка цвета одна на все комплектации');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'images', s26.images[0])), 'картинка скачана');
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'images', 'site_stale0000000000000000.webp')), 'лишняя картинка ленты убрана');
  assert.ok(siteHits.some(h => h.url === '/api/bot/catalog' && h.key === KEY), 'лента — по ключу сайта');
});

test('/start: кнопочный магазин как раньше — клавиатура внизу, «Открыть в приложении» ведёт на сайт', async () => {
  const mark = calls.length;
  assert.strictEqual((await update(4242, '/start')).status, 200);
  const list = await waitFor(() => { const l = sentTo(4242, mark); return l.length >= 2 ? l : null; });
  const kb = list[0].body.reply_markup.keyboard.flat().map(b => b.text);
  assert.ok(kb.includes('🛍 Каталог') && kb.includes('🛒 Корзина') && kb.includes('📦 Мои заказы'), kb.join(', '));
  const inline = list[1].body.reply_markup.inline_keyboard.flat();
  assert.ok(inline.some(b => b.web_app && b.web_app.url === SITE), '«Открыть в приложении» — сайт');
});

test('поиск в чате находит товар с сайта, карточка с кнопкой этой комплектации', async () => {
  let mark = calls.length;
  await update(4244, '🔎 Поиск');
  await waitFor(() => sentTo(4244, mark).length);
  mark = calls.length;
  await update(4244, 's26 ultra 512');
  const res = await waitFor(() => { const l = sentTo(4244, mark); return l.length ? l : null; });
  const all = res.flatMap(m => JSON.stringify(m.body));
  assert.ok(all.some(t => /Galaxy S26 Ultra 12\/512/.test(t)), 'нашёлся по названию с памятью');
});

test('заказ из корзины уходит копией на сайт', async () => {
  const id = products().find(p => p.siteKey === 'p|a3aedefb').id;
  const r = await fetch(BASE + '/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id, qty: 1 }], customer: { name: 'Давид', phone: '+79161234567' } }),
  });
  assert.strictEqual(r.status, 200, await r.text());
  const hit = await waitFor(() => siteHits.find(h => h.url === '/api/bot/order'));
  assert.strictEqual(hit.key, KEY);
  const body = JSON.parse(hit.body);
  assert.strictEqual(body.items[0].name, 'iPad Pro 11 M5 256 ГБ');
  assert.strictEqual(body.total, 150000);
  assert.strictEqual(body.customer.phone, '+79161234567');
});

test('/admin владельца: панель — админка сайта', async () => {
  const mark = calls.length;
  await update(777, '/admin');
  const msg = await waitFor(() => sentTo(777, mark).find(m => m.body.reply_markup && m.body.reply_markup.inline_keyboard));
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
