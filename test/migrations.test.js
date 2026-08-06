// Миграции MySQL: схема создаётся, повторный прогон безопасен, контрольные
// суммы ловят правку применённого файла, каскады и JSON-колонки работают.
// Нужен живой MySQL (MYSQL_* в .env). Без него тесты пропускаются, а не
// падают — файловый режим от БД не зависит.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

require('../server/env').loadEnv();
const { createDb, dbConfigFromEnv } = require('../server/db');
const { createMigrator } = require('../server/migrations');

const cfg = dbConfigFromEnv();
// БД на прогон: имя случайное, чтобы параллельные запуски не пересекались.
const TEST_DB = 'kitaec_mig_' + Math.random().toString(36).slice(2, 8);

let db;       // пул на тестовую базу
let root;     // пул без database — создавать/ронять саму базу
let migrator;
let available = false;

const TABLES = [
  'schema_migrations', 'tenants', 'shops', 'shop_settings', 'products',
  'product_images', 'images', 'orders', 'order_items', 'product_views',
];

test.before(async () => {
  if (!cfg.host) return; // БД не настроена — тесты пропускаются
  try {
    root = createDb({ ...cfg, database: undefined });
    await root.query(`CREATE DATABASE \`${TEST_DB}\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = createDb({ ...cfg, database: TEST_DB });
    migrator = createMigrator({ db });
    available = true;
  } catch (e) {
    // сервер не отвечает — тоже не повод ронять suite
    available = false;
  }
});

test.after(async () => {
  if (db) await db.end().catch(() => {});
  if (root) {
    if (available) await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``).catch(() => {});
    await root.end().catch(() => {});
  }
});

const skip = t => { if (!available) { t.skip('MySQL недоступен'); return true; } return false; };

test('up() создаёт всю схему и фиксирует миграцию', async t => {
  if (skip(t)) return;
  const applied = await migrator.up();
  assert.deepStrictEqual(applied, ['0001_core.sql']);

  const [rows] = await db.query('SHOW TABLES');
  const tables = rows.map(r => Object.values(r)[0]).sort();
  for (const name of TABLES) assert.ok(tables.includes(name), `нет таблицы ${name}`);
});

test('повторный up() ничего не применяет (идемпотентность)', async t => {
  if (skip(t)) return;
  assert.deepStrictEqual(await migrator.up(), []);
  const status = await migrator.status();
  assert.deepStrictEqual(status, [{ name: '0001_core.sql', state: 'applied' }]);
});

test('правленный файл применённой миграции отклоняется', async t => {
  if (skip(t)) return;
  // Портим контрольную сумму: будто кто-то отредактировал уже накатанный файл
  await db.query("UPDATE schema_migrations SET checksum = REPEAT('0', 64)");
  await assert.rejects(() => migrator.up(), /файл изменился/);
  await assert.rejects(() => migrator.up(), /добавьте новую/);
});

test('каскад: удаление арендатора вычищает магазин и его данные', async t => {
  if (skip(t)) return;

  await db.query("INSERT INTO tenants (slug, name) VALUES ('acme', 'ООО Тест')");
  const [[tenant]] = await db.query("SELECT id FROM tenants WHERE slug = 'acme'");
  await db.query(
    'INSERT INTO shops (tenant_id, subdomain, title) VALUES (?, ?, ?)',
    [tenant.id, 'acme-shop', 'Тестовый магазин']);
  const [[shop]] = await db.query("SELECT id FROM shops WHERE subdomain = 'acme-shop'");

  await db.query(
    'INSERT INTO products (shop_id, legacy_id, name, price, stock) VALUES (?, ?, ?, ?, ?)',
    [shop.id, '1720000000000', 'Кружка', 500, 10]);
  const [[prod]] = await db.query('SELECT id FROM products WHERE shop_id = ?', [shop.id]);
  await db.query(
    `INSERT INTO orders (shop_id, id, at, status, total, subtotal, customer, raw)
     VALUES (?, ?, NOW(3), 'new', 500, 500, ?, ?)`,
    [shop.id, 1750000000000,
      JSON.stringify({ name: 'Пётр', phone: '+79990000000' }),
      JSON.stringify({ id: 1750000000000, extra: 'поле, которого схема не знает' })]);
  await db.query(
    `INSERT INTO order_items (shop_id, order_id, pos, product_id, name, price, qty)
     VALUES (?, ?, 0, ?, 'Кружка', 500, 1)`,
    [shop.id, 1750000000000, prod.id]);

  await db.query('DELETE FROM tenants WHERE id = ?', [tenant.id]);

  for (const [table, col, val] of [
    ['shops', 'id', shop.id], ['products', 'id', prod.id],
    ['orders', 'shop_id', shop.id], ['order_items', 'shop_id', shop.id],
  ]) {
    const [left] = await db.query(`SELECT 1 FROM \`${table}\` WHERE \`${col}\` = ?`, [val]);
    assert.strictEqual(left.length, 0, `${table} не вычистился каскадом`);
  }
});

test('JSON-колонки переживают кириллицу и читаются объектом', async t => {
  if (skip(t)) return;

  await db.query("INSERT INTO tenants (slug, name) VALUES ('json-test', 'ИП Иванов')");
  const [[tenant]] = await db.query("SELECT id FROM tenants WHERE slug = 'json-test'");
  await db.query(
    'INSERT INTO shops (tenant_id, subdomain, admin_chat_ids) VALUES (?, ?, ?)',
    [tenant.id, 'json-shop', JSON.stringify([123456789, 987654321])]);
  const [[shop]] = await db.query("SELECT id FROM shops WHERE subdomain = 'json-shop'");

  const settings = { brand: { name: 'Магазин «Ромашка» 🌼' }, advanced: { locale: 'ru-RU' } };
  await db.query('INSERT INTO shop_settings (shop_id, settings) VALUES (?, ?)',
    [shop.id, JSON.stringify(settings)]);

  const [[row]] = await db.query('SELECT settings FROM shop_settings WHERE shop_id = ?', [shop.id]);
  // mysql2 сам парсит JSON-колонки в объекты
  assert.strictEqual(row.settings.brand.name, 'Магазин «Ромашка» 🌼');

  const [[shopRow]] = await db.query('SELECT admin_chat_ids FROM shops WHERE id = ?', [shop.id]);
  assert.deepStrictEqual(shopRow.admin_chat_ids, [123456789, 987654321]);
});

test('уникальность subdomain и legacy_id охраняется БД', async t => {
  if (skip(t)) return;

  await db.query("INSERT INTO tenants (slug, name) VALUES ('uniq', 'x')");
  const [[tenant]] = await db.query("SELECT id FROM tenants WHERE slug = 'uniq'");
  await db.query('INSERT INTO shops (tenant_id, subdomain) VALUES (?, ?)', [tenant.id, 'dup-shop']);
  await assert.rejects(
    () => db.query('INSERT INTO shops (tenant_id, subdomain) VALUES (?, ?)', [tenant.id, 'dup-shop']),
    err => err.code === 'ER_DUP_ENTRY');

  const [[shop]] = await db.query("SELECT id FROM shops WHERE subdomain = 'dup-shop'");
  await db.query('INSERT INTO products (shop_id, legacy_id, name, price) VALUES (?, ?, ?, ?)',
    [shop.id, '42', 'Один', 1]);
  await assert.rejects(
    () => db.query('INSERT INTO products (shop_id, legacy_id, name, price) VALUES (?, ?, ?, ?)',
      [shop.id, '42', 'Два', 2]),
    err => err.code === 'ER_DUP_ENTRY');
});

test('файлы миграций режутся на операторы без мусора', async t => {
  // Проверка вне зависимости от MySQL: парсер операторов самого мигратора
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mig-split-'));
  fs.writeFileSync(path.join(dir, '0001_x.sql'),
    '-- комментарий\nCREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);\n');
  // db не нужен: берём только синхронную часть через pendingFiles/статус нельзя,
  // поэтому проверяем поведение через временный мигратор с заглушкой
  const fakeDb = {
    queries: [],
    query: async (sql, params) => { fakeDb.queries.push({ sql, params }); return [[], []]; },
    tx: async fn => fn(fakeDb),
  };
  const m = createMigrator({ db: fakeDb, dir });
  await m.up();
  const stmts = fakeDb.queries.map(q => q.sql).filter(s => /CREATE TABLE (a|b) /.test(s));
  assert.strictEqual(stmts.length, 2, 'должно быть ровно два CREATE TABLE из файла');
  assert.ok(!fakeDb.queries.some(q => q.sql.includes('--')), 'комментарии не уехали в SQL');
  fs.rmSync(dir, { recursive: true, force: true });
});
