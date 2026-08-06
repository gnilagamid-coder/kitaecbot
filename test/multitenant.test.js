// Мультитенантность: секреты, реестр, provisioning, импортёр, роутинг
// по поддоменам, регистрация и слой данных на MySQL (Stage 4): магазины
// переживают рестарт платформы, потому что их документы — в shop_docs.
// Юнит-часть работает без MySQL; интеграционная пропускается, если БД не
// настроена (как в migrations.test.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

require('../server/env').loadEnv();
const { encryptSecret, decryptSecret } = require('../server/secrets');
const { validateSubdomain, createRegistry } = require('../server/registry');
const { createTenant } = require('../server/tenant');
const { provisionShop } = require('../server/provision');
const { importLegacy } = require('../server/import-shop');
const { createDb, dbConfigFromEnv } = require('../server/db');
const { createMigrator } = require('../server/migrations');

// ---------- окружение интеграции ----------
const cfg = dbConfigFromEnv();
const TEST_DB = 'kitaec_mt_' + Math.random().toString(36).slice(2, 8);
const SECRET = 'platform-test-secret-42';
const DOMAIN = 'example.test';
const PORT = 4800 + Math.floor(Math.random() * 300);
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-mt-root-'));

let db, root, registry, child;
let available = false;   // MySQL поднялся
let platformUp = false;  // сервер платформы поднялся

// Запуск платформы отдельным процессом. Используется и в before, и в тесте
// на рестарт — там процесс убивается и поднимается заново поверх той же БД.
function spawnPlatform() {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      MULTITENANT: '1',
      MULTITENANT_DOMAIN: DOMAIN,
      MULTITENANT_DATA_ROOT: DATA_ROOT,
      MYSQL_DATABASE: TEST_DB,
      SECRET_KEY: SECRET,
      ADMIN_TOKEN: '', BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stderr.on('data', d => { if (process.env.MT_DEBUG) console.error('[child stderr]', String(d)); });
  return c;
}

// Готовность — строка запуска платформы в stdout (реестр к этому моменту поднят)
function waitReady(c) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('платформа не поднялась за 15 секунд')), 15000);
    c.stdout.on('data', d => {
      if (process.env.MT_DEBUG) console.error('[child stdout]', String(d));
      if (String(d).includes('[platform]')) { clearTimeout(timer); resolve(); }
    });
    c.on('exit', code => reject(new Error(`сервер умер при старте (код ${code})`)));
  });
}

// Один before на всё: сначала БД, потом платформа поверх неё. Хуки в node:test
// держим в начале файла — регистрация после тестов работает нестабильно.
test.before(async () => {
  if (!cfg.host) return; // БД не настроена — интеграция пропускается
  try {
    root = createDb({ ...cfg, database: undefined });
    await root.query(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = createDb({ ...cfg, database: TEST_DB });
    await createMigrator({ db }).up();
    registry = createRegistry(db);
    available = true;
  } catch (e) {
    available = false;
    return;
  }

  child = spawnPlatform();
  try {
    await waitReady(child);
    platformUp = true;
  } catch (e) {
    console.error('[multitenant test]', e.message);
    platformUp = false;
  }
});

test.after(async () => {
  if (child) child.kill();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  if (db) await db.end().catch(() => {});
  if (root) {
    if (available) await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``).catch(() => {});
    await root.end().catch(() => {});
  }
});

const skipDb = t => { if (!available) { t.skip('MySQL недоступен'); return true; } return false; };
const skipHttp = t => { if (!platformUp) { t.skip('платформа не поднялась'); return true; } return false; };

// ---------- секреты ----------
test('encryptSecret/decryptSecret: раунд-трип, случайный IV', () => {
  const key = 'test-secret-key-12345';
  const a = encryptSecret('123456:ABC-DEF', key);
  const b = encryptSecret('123456:ABC-DEF', key);
  assert.notStrictEqual(a, b, 'одинаковый текст должен давать разные шифртексты');
  assert.strictEqual(decryptSecret(a, key), '123456:ABC-DEF');
  assert.strictEqual(decryptSecret(b, key), '123456:ABC-DEF');
  assert.ok(a.startsWith('v1.'));
});

test('decryptSecret: неверный ключ и порча данных отклоняются', () => {
  const enc = encryptSecret('секрет', 'right-key-12345');
  assert.throws(() => decryptSecret(enc, 'wrong-key-12345'));
  assert.throws(() => decryptSecret('v1.мусор', 'right-key-12345'));
  assert.throws(() => encryptSecret('x', 'короткий'), /SECRET_KEY/);
});

// ---------- поддомены ----------
test('validateSubdomain: формат и зарезервированные имена', () => {
  assert.deepStrictEqual(validateSubdomain('Shop-1'), { ok: true, subdomain: 'shop-1' });
  assert.ok(validateSubdomain('ab').ok);
  for (const bad of ['', 'a', '-bad', 'bad-', 'a.b', 'кириллица', 'x'.repeat(33)]) {
    assert.ok(!validateSubdomain(bad).ok, `должен отклонить «${bad}»`);
  }
  for (const r of ['www', 'api', 'admin', 'platform']) {
    assert.ok(!validateSubdomain(r).ok, `«${r}» зарезервирован`);
  }
});

// ---------- арендатор из реестра ----------
test('createTenant принимает готовый adminHash и sessionKey', () => {
  const hash = crypto.createHash('sha256').update('пароль-из-бд').digest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-t3-'));
  const t = createTenant({ id: 'x', dataDir: dir, adminHash: hash, sessionKey: 'sess-key' });
  assert.ok(t.adminHash.equals(hash), 'хэш взят из БД, а не считается из пустого adminToken');
  assert.strictEqual(t.sessionKey, 'sess-key');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- provisioning ----------
test('provisionShop: строки реестра, папка данных, дубликат отклоняется', async t => {
  if (skipDb(t)) return;
  const p = await provisionShop({
    registry, dataRoot: DATA_ROOT, subdomain: 'demo',
    shopName: 'Тестовый магазин', email: 'owner@example.com', secretKey: SECRET,
  });
  assert.ok(p.adminToken.length >= 20, 'пароль админки достаточно длинный');

  const row = await registry.findShopBySubdomain('demo');
  assert.ok(row, 'магазин найден по поддомену');
  assert.strictEqual(row.status, 'active');
  assert.strictEqual(row.title, 'Тестовый магазин');
  assert.strictEqual(row.admin_token_hash,
    crypto.createHash('sha256').update(p.adminToken).digest('hex'),
    'в БД лежит sha256 пароля, а не он сам');

  // Дефолтные настройки — в shop_docs (данные платформы живут в MySQL)
  const [[doc]] = await db.query(
    'SELECT data FROM shop_docs WHERE shop_id = ? AND doc = ?', [p.shopId, 'settings']);
  assert.strictEqual(doc.data.brand.shopName, 'Тестовый магазин');
  assert.strictEqual(doc.data.theme.preset, 'glass', 'новый магазин — Liquid Glass по умолчанию');
  assert.ok(fs.existsSync(path.join(p.dataDir, 'images')), 'папка картинок создана');

  await assert.rejects(
    () => provisionShop({ registry, dataRoot: DATA_ROOT, subdomain: 'demo', secretKey: SECRET }),
    /занят/);
});

test('provisionShop: токен бота шифруется и расшифровывается', async t => {
  if (skipDb(t)) return;
  const p = await provisionShop({
    registry, dataRoot: DATA_ROOT, subdomain: 'withbot',
    shopName: 'С ботом', botToken: '999999:TESTTOKEN', secretKey: SECRET,
  });
  const row = await registry.findShopBySubdomain('withbot');
  assert.ok(row.bot_token_enc, 'токен записан');
  assert.notStrictEqual(Buffer.from(row.bot_token_enc).toString('utf8'), '999999:TESTTOKEN',
    'в БД не должен лежать открытый токен');
  assert.strictEqual(decryptSecret(Buffer.from(row.bot_token_enc).toString('utf8'), SECRET), '999999:TESTTOKEN');
  assert.ok(p.shopId);
});

// ---------- импортёр ----------
test('importLegacy: товары, заказы, картинки и просмотры без потерь', async t => {
  if (skipDb(t)) return;

  // Синтетическая папка файлового магазина
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-legacy-'));
  fs.mkdirSync(path.join(legacy, 'images'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(legacy, 'images', 'img_a.png'), png);
  fs.writeFileSync(path.join(legacy, 'settings.json'),
    JSON.stringify({ brand: { shopName: 'Легаси' }, theme: { preset: 'brutalist' } }));
  fs.writeFileSync(path.join(legacy, 'products.json'), JSON.stringify([
    { id: 111, name: 'Кружка', price: 500, stock: 3, images: ['img_a.png'], thumbs: ['img_a.png'] },
    { id: 222, name: 'Скрытое', price: 10, hidden: true },
  ]));
  fs.writeFileSync(path.join(legacy, 'orders.json'), JSON.stringify([
    {
      id: 1785872157966, at: '2026-08-04T19:35:57.966Z',
      items: [
        { id: 111, name: 'Кружка', price: 500, qty: 2 },
        { id: 999, name: 'Удалённый товар', price: 50, qty: 1 },
      ],
      total: 1050, subtotal: 1050, promo: null,
      customer: { name: 'Пётр', phone: '+79001234567' },
      user: { id: 42, username: 'petya' }, status: 'processing',
      note: 'поле, которого схема не знает',
    },
  ]));
  fs.writeFileSync(path.join(legacy, 'views.json'), JSON.stringify({ '111': 7, '222': 3 }));

  const r = await importLegacy({
    db, registry, dataDir: legacy, subdomain: 'legacy1',
    dataRoot: DATA_ROOT, secretKey: SECRET,
  });
  assert.deepStrictEqual(
    { products: r.products, orders: r.orders, images: r.images },
    { products: 2, orders: 1, images: 1 });

  // Товары: legacy_id сохранён, порядок и флаги доехали
  const [prods] = await db.query('SELECT legacy_id, name, price, stock, hidden, sort FROM products WHERE shop_id = ? ORDER BY sort', [r.shopId]);
  assert.strictEqual(prods.length, 2);
  assert.strictEqual(prods[0].legacy_id, '111');
  assert.strictEqual(Number(prods[0].stock), 3);
  assert.strictEqual(prods[1].hidden, 1);

  // Картинки: байты идентичны источнику, связь full+thumb
  const [[img]] = await db.query('SELECT bytes, content_type FROM images WHERE shop_id = ?', [r.shopId]);
  assert.ok(Buffer.compare(Buffer.from(img.bytes), png) === 0, 'байты картинки не потерялись');
  assert.strictEqual(img.content_type, 'image/png');
  const [pi] = await db.query('SELECT kind FROM product_images WHERE shop_id = ?', [r.shopId]);
  assert.deepStrictEqual(pi.map(x => x.kind).sort(), ['full', 'thumb']);

  // Заказ: статус, raw с незнакомым полем, позиции с product_id
  const [[ord]] = await db.query('SELECT status, total, tg_user, raw FROM orders WHERE shop_id = ?', [r.shopId]);
  assert.strictEqual(ord.status, 'processing');
  assert.strictEqual(Number(ord.total), 1050);
  assert.strictEqual(ord.tg_user.username, 'petya');
  const raw = typeof ord.raw === 'string' ? JSON.parse(ord.raw) : ord.raw; // mysql2 парсит JSON-колонки сам
  assert.strictEqual(raw.note, 'поле, которого схема не знает');

  const [items] = await db.query('SELECT name, product_id, qty FROM order_items WHERE shop_id = ? ORDER BY pos', [r.shopId]);
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].product_id, 'позиция живого товара связана с product');
  assert.strictEqual(items[1].product_id, null, 'позиция удалённого товара — без связи');
  assert.strictEqual(items[0].qty, 2);

  // Просмотры и настройки
  const [views] = await db.query('SELECT product_key, views FROM product_views WHERE shop_id = ? ORDER BY product_key', [r.shopId]);
  assert.deepStrictEqual(views.map(v => [v.product_key, v.views]), [['111', 7], ['222', 3]]);
  const [[st]] = await db.query('SELECT settings FROM shop_settings WHERE shop_id = ?', [r.shopId]);
  assert.strictEqual(st.settings.brand.shopName, 'Легаси');
  assert.strictEqual(st.settings.theme.preset, 'brutalist', 'выбранный пресет магазина не заменяется дефолтом');

  // Живые документы магазина — в shop_docs, на диске только картинки
  const [docs] = await db.query('SELECT doc, data FROM shop_docs WHERE shop_id = ?', [r.shopId]);
  const byDoc = Object.fromEntries(docs.map(d => [d.doc, d.data]));
  assert.strictEqual(byDoc.settings.brand.shopName, 'Легаси');
  assert.strictEqual(byDoc.settings.theme.preset, 'brutalist', 'выбранный пресет магазина не заменяется дефолтом');
  assert.deepStrictEqual(byDoc.products.map(x => x.id), [111, 222]);
  assert.strictEqual(byDoc.orders[0].note, 'поле, которого схема не знает');
  assert.deepStrictEqual(byDoc.views, { 111: 7, 222: 3 });
  assert.ok(fs.existsSync(path.join(r.dataDir, 'images', 'img_a.png')));
  assert.ok(!fs.existsSync(path.join(r.dataDir, 'products.json')), 'JSON уехал из папки в БД');
  fs.rmSync(legacy, { recursive: true, force: true });
});

// ---------- платформа целиком: HTTP-роутинг по поддоменам ----------
function httpReq({ method = 'GET', p = '/', host = '', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: p,
      headers: {
        ...headers,
        ...(host ? { host } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch (e) { /* не json */ }
        resolve({ status: res.statusCode, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('голый домен отдаёт лендинг платформы', async t => {
  if (skipHttp(t)) return;
  const r = await httpReq({ host: DOMAIN });
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('Свой магазин за минуту'), 'лендинг регистрации на месте');
});

test('регистрация создаёт магазин, витрина отвечает на поддомене', async t => {
  if (skipHttp(t)) return;
  const reg = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Ромашка', subdomain: 'romashka', email: 'r@example.com' },
  });
  assert.strictEqual(reg.status, 200, reg.text);
  assert.strictEqual(reg.json.subdomain, 'romashka');
  assert.ok(reg.json.adminToken, 'одноразовый пароль админки выдан');

  // Витрина магазина — свои настройки, не соседа
  const s = await httpReq({ host: 'romashka.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.json.brand.shopName, 'Ромашка');

  // Изоляция: два магазина — два набора настроек
  const reg2 = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Второй', subdomain: 'vtoroy' },
  });
  assert.strictEqual(reg2.status, 200);
  const s2 = await httpReq({ host: 'vtoroy.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(s2.json.brand.shopName, 'Второй');
  const s1again = await httpReq({ host: 'romashka.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(s1again.json.brand.shopName, 'Ромашка', 'соседи не видят чужие настройки');
});

test('админка магазина: пароль из регистрации пускает, чужой — нет', async t => {
  if (skipHttp(t)) return;
  const reg = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Секретный', subdomain: 'sekret' },
  });
  const token = reg.json.adminToken;

  const bad = await httpReq({
    method: 'PUT', p: '/api/admin/settings', host: 'sekret.' + DOMAIN,
    body: { brand: { shopName: 'Взлом' } }, headers: { 'x-admin-token': 'wrong-token' },
  });
  assert.strictEqual(bad.status, 401);

  const ok = await httpReq({
    method: 'PUT', p: '/api/admin/settings', host: 'sekret.' + DOMAIN,
    body: { brand: { shopName: 'Секретный 2' } }, headers: { 'x-admin-token': token },
  });
  assert.strictEqual(ok.status, 200, ok.text);

  const s = await httpReq({ host: 'sekret.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(s.json.brand.shopName, 'Секретный 2');
});

test('неизвестный поддомен и занятый поддомен обработаны', async t => {
  if (skipHttp(t)) return;
  const miss = await httpReq({ host: 'nosuch.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(miss.status, 404);

  const dup = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Дубль', subdomain: 'romashka' },
  });
  assert.strictEqual(dup.status, 409);
  assert.ok(/занят/.test(dup.json.error));
});

test('рестарт платформы: данные магазинов переживают остановку', async t => {
  if (skipHttp(t)) return;

  // Магазин с изменением, сделанным через админку прямо перед остановкой.
  const reg = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Долгожитель', subdomain: 'doom' },
  });
  assert.strictEqual(reg.status, 200, reg.text);
  const put = await httpReq({
    method: 'PUT', p: '/api/admin/settings', host: 'doom.' + DOMAIN,
    body: { brand: { shopName: 'Пережил рестарт' } },
    headers: { 'x-admin-token': reg.json.adminToken },
  });
  assert.strictEqual(put.status, 200, put.text);
  // Запись в MySQL идёт асинхронной очередью — даём ей дописать до kill.
  await new Promise(r => setTimeout(r, 500));

  await new Promise(resolve => { child.on('exit', resolve); child.kill(); });
  child = spawnPlatform();
  await waitReady(child);

  const doom = await httpReq({ host: 'doom.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(doom.status, 200);
  assert.strictEqual(doom.json.brand.shopName, 'Пережил рестарт',
    'изменение из админки пережило рестарт — данные в MySQL');
  const rom = await httpReq({ host: 'romashka.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(rom.json.brand.shopName, 'Ромашка', 'старые магазины поднялись из реестра');
});
