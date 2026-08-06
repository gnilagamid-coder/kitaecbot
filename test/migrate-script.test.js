'use strict';
// Скрипт переезда файлы → SQLite. Проверяем главное: ничего не теряется,
// исходники остаются нетронутыми, а при расхождении скрипт честно падает.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { main } = require('../scripts/migrate-to-sqlite');
const { createStore } = require('../server/store');
const { createOrders } = require('../server/orders');
const { openAndMigrate } = require('../server/db');
const { createSqliteStore } = require('../server/store-sqlite');
const { createSqlOrders } = require('../server/orders-sqlite');

// Скрипт печатает много — глушим вывод, чтобы не засорять отчёт тестов.
function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = err; }
}

// Готовим папку данных ровно так, как её создаёт живой магазин.
// Обязательно с flush: файловый бэкенд пишет через очередь, и без ожидания
// скрипт увидел бы пустую папку — как это и случилось при первом прогоне.
async function makeShop({ orders: n = 5, archived = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-mig-'));
  const store = createStore(dir);
  const repo = createOrders(store);

  store.write('settings', { brand: { shopName: 'ПЕРЕЕЗД' }, commerce: { currency: '€' } });
  store.write('products', [{ id: 1, name: 'Кружка', price: 500 }, { id: 2, name: 'Плед', price: 900 }]);
  store.write('users', { 42: { id: 42, name: 'Аня', subAnnounce: true } });
  store.write('views', { 1: 17 });

  const total = archived ? repo.HOT_LIMIT + n : n;
  for (let i = 0; i < total; i++) {
    repo.add({
      id: 2000 + i,
      at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      items: [{ id: 1, name: 'Кружка', price: 500, qty: 1 }],
      total: 500, subtotal: 500, promo: null,
      customer: { name: 'Покупатель ' + i, phone: '+7900000' + i },
      user: null, status: i % 4 === 0 ? 'done' : 'new',
    });
  }
  await store.flush();
  return { dir, store, repo };
}

function openMigrated(dir) {
  const db = openAndMigrate(path.join(dir, 'shop.db'));
  return {
    store: createSqliteStore({ db, imgDir: path.join(dir, 'images') }),
    orders: createSqlOrders(db),
  };
}

test('переезд переносит документы и заказы без потерь', async () => {
  const { dir, repo } = await makeShop({ orders: 7 });
  const before = repo.stats();

  const code = quiet(() => main(['--data', dir]));
  assert.strictEqual(code, 0, 'скрипт должен завершиться успешно');

  const after = openMigrated(dir);
  assert.strictEqual(after.orders.stats().total, before.total);
  assert.strictEqual(after.orders.stats().revenue, before.revenue);
  assert.deepStrictEqual(after.orders.stats().byStatus, before.byStatus);

  assert.strictEqual(after.store.read('settings', {}).brand.shopName, 'ПЕРЕЕЗД');
  assert.strictEqual(after.store.read('products', []).length, 2);
  assert.strictEqual(after.store.read('users', {})[42].name, 'Аня');
  assert.strictEqual(after.store.read('views', {})[1], 17);
});

test('заказы из архива тоже переезжают', async () => {
  const { dir, repo } = await makeShop({ orders: 4, archived: true });
  const before = repo.stats();
  assert.ok(before.archived > 0, 'подготовка: часть заказов должна быть в архиве');

  assert.strictEqual(quiet(() => main(['--data', dir])), 0);

  const after = openMigrated(dir);
  assert.strictEqual(after.orders.stats().total, before.total,
    'в базе должны оказаться и горячие, и архивные');
  // самый старый заказ лежал в архиве — он обязан находиться по номеру
  assert.ok(after.orders.find(2000), 'самый первый заказ должен быть в базе');
});

test('содержимое заказа переносится целиком', async () => {
  const { dir } = await makeShop({ orders: 3 });
  quiet(() => main(['--data', dir]));
  const after = openMigrated(dir);
  const o = after.orders.find(2001);
  assert.strictEqual(o.customer.name, 'Покупатель 1');
  assert.strictEqual(o.customer.phone, '+79000001');
  assert.strictEqual(o.items[0].name, 'Кружка');
  assert.strictEqual(o.total, 500);
});

test('исходные файлы остаются нетронутыми — это бэкап', async () => {
  const { dir } = await makeShop({ orders: 3 });
  const before = fs.readFileSync(path.join(dir, 'orders.json'), 'utf8');
  const settingsBefore = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');

  quiet(() => main(['--data', dir]));

  assert.strictEqual(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8'), before);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), settingsBefore);
});

test('повторный запуск без --force отказывается работать', async () => {
  const { dir } = await makeShop({ orders: 2 });
  assert.strictEqual(quiet(() => main(['--data', dir])), 0);
  // второй прогон задвоил бы заказы — скрипт обязан остановиться сам
  assert.strictEqual(quiet(() => main(['--data', dir])), 1);
});

test('несуществующая папка — понятная ошибка, а не стектрейс', () => {
  assert.strictEqual(quiet(() => main(['--data', path.join(os.tmpdir(), 'нет-такой-папки-' + Date.now())])), 1);
});

test('без аргументов печатает справку и не делает ничего', () => {
  assert.strictEqual(quiet(() => main([])), 1);
});
