// store-db: документы магазина в MySQL. Интерфейс обязан совпадать с
// createStore — проверяем чтение/запись, переживаемость рестарта (новый
// экземпляр видит те же данные), порядок очереди записи и картинки на диске.
// Нужен живой MySQL (MYSQL_* в .env). Без него тесты пропускаются.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

require('../server/env').loadEnv();
const { createDb, dbConfigFromEnv } = require('../server/db');
const { createMigrator } = require('../server/migrations');
const { createDbStore } = require('../server/store-db');

const cfg = dbConfigFromEnv();
const TEST_DB = 'kitaec_docs_' + Math.random().toString(36).slice(2, 8);

let db, root, shopId;
let dataDir;
let available = false;

test.before(async () => {
  if (!cfg.host) return; // БД не настроена — тесты пропускаются
  try {
    root = createDb({ ...cfg, database: undefined });
    await root.query(`CREATE DATABASE \`${TEST_DB}\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = createDb({ ...cfg, database: TEST_DB });
    await createMigrator({ db }).up();

    await db.query("INSERT INTO tenants (slug, name) VALUES ('docs', 'x')");
    const [[t]] = await db.query("SELECT id FROM tenants WHERE slug = 'docs'");
    await db.query('INSERT INTO shops (tenant_id, subdomain) VALUES (?, ?)', [t.id, 'docs-shop']);
    const [[s]] = await db.query("SELECT id FROM shops WHERE subdomain = 'docs-shop'");
    shopId = s.id;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-store-'));
    available = true;
  } catch (e) {
    available = false;
  }
});

test.after(async () => {
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (db) await db.end().catch(() => {});
  if (root) {
    if (available) await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``).catch(() => {});
    await root.end().catch(() => {});
  }
});

const skip = t => { if (!available) { t.skip('MySQL недоступен'); return true; } return false; };

test('read/write: кэш синхронный, документ лежит в MySQL', async t => {
  if (skip(t)) return;
  const store = await createDbStore({ db, shopId, dataDir });

  // Чего нет — отдаём fallback, как файловый стор.
  assert.deepStrictEqual(store.read('products', []), []);
  assert.strictEqual(store.read('settings', null), null);

  store.write('settings', { brand: { shopName: 'Магазин «Ромашка» 🌼' } });
  // Кэш обновился сразу, синхронно.
  assert.strictEqual(store.read('settings').brand.shopName, 'Магазин «Ромашка» 🌼');
  await store.flush();

  const [[row]] = await db.query('SELECT data FROM shop_docs WHERE shop_id = ? AND doc = ?', [shopId, 'settings']);
  assert.strictEqual(row.data.brand.shopName, 'Магазин «Ромашка» 🌼');
});

test('второй экземпляр видит те же данные (эмуляция рестарта)', async t => {
  if (skip(t)) return;
  const s1 = await createDbStore({ db, shopId, dataDir });
  s1.write('orders', [{ id: 1, note: 'первый' }, { id: 2, note: 'второй' }]);
  await s1.flush();

  const s2 = await createDbStore({ db, shopId, dataDir });
  assert.deepStrictEqual(s2.read('orders').map(o => o.note), ['первый', 'второй']);
  assert.strictEqual(s2.read('settings').brand.shopName, 'Магазин «Ромашка» 🌼');
});

test('очередь записи: последнее значение побеждает по порядку', async t => {
  if (skip(t)) return;
  const store = await createDbStore({ db, shopId, dataDir });
  // Пачка быстрых записей одного документа — UPSERT обязаны идти последовательно.
  for (let i = 0; i < 20; i++) store.write('views', { seq: i });
  await store.flush();

  const [[row]] = await db.query('SELECT data FROM shop_docs WHERE shop_id = ? AND doc = ?', [shopId, 'views']);
  assert.strictEqual(row.data.seq, 19);
  assert.strictEqual(store.read('views').seq, 19);
});

test('reload подхватывает правку, внесённую мимо кэша', async t => {
  if (skip(t)) return;
  const store = await createDbStore({ db, shopId, dataDir });
  store.write('users', [{ id: 1 }]);
  await store.flush();

  await db.query('UPDATE shop_docs SET data = ? WHERE shop_id = ? AND doc = ?',
    [JSON.stringify([{ id: 1 }, { id: 2 }]), shopId, 'users']);
  await store.reload();
  assert.deepStrictEqual(store.read('users').map(u => u.id), [1, 2]);
});

test('картинки делегированы файловому слою, как в createStore', async t => {
  if (skip(t)) return;
  const store = await createDbStore({ db, shopId, dataDir });

  // 1x1 png
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const id = await store.saveImage('image/png', png);
  assert.match(id, /^img_[a-z0-9]+\.png$/);

  const file = store.imagePath(id);
  assert.ok(file && fs.existsSync(file), 'картинка лежит в папке магазина');
  assert.strictEqual(fs.readFileSync(file).toString('base64'), png);

  // ../ не выводит наружу
  assert.strictEqual(store.imagePath('../../etc/passwd'), null);

  await store.deleteImage(id);
  assert.strictEqual(store.imagePath(id), null);
});

test('документы соседа не видны (изоляция по shop_id)', async t => {
  if (skip(t)) return;
  await db.query('INSERT INTO shops (tenant_id, subdomain) VALUES ((SELECT id FROM tenants WHERE slug = ?), ?)',
    ['docs', 'docs-shop-2']);
  const [[s2row]] = await db.query("SELECT id FROM shops WHERE subdomain = 'docs-shop-2'");

  const other = await createDbStore({ db, shopId: s2row.id, dataDir });
  assert.strictEqual(other.read('settings', null), null, 'чужие settings не протекают');
  other.write('settings', { brand: { shopName: 'Сосед' } });
  await other.flush();

  const mine = await createDbStore({ db, shopId, dataDir });
  assert.strictEqual(mine.read('settings').brand.shopName, 'Магазин «Ромашка» 🌼');
});
