'use strict';
// Оба бэкенда обязаны вести себя одинаково. Тесты написаны один раз и
// прогоняются по каждой реализации: если файловый и SQL начнут расходиться,
// это увидит не продавец в проде, а сборка.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../server/store');
const { createOrders } = require('../server/orders');
const { openAndMigrate } = require('../server/db');
const { createSqliteStore } = require('../server/store-sqlite');
const { createSqlOrders } = require('../server/orders-sqlite');

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-' + name + '-'));

const BACKENDS = {
  file() {
    const dir = tmp('file');
    const store = createStore(dir);
    return { store, orders: createOrders(store) };
  },
  sqlite() {
    const dir = tmp('sqlite');
    const db = openAndMigrate(path.join(dir, 'shop.db'));
    const store = createSqliteStore({ db, imgDir: path.join(dir, 'images') });
    return { store, orders: createSqlOrders(db) };
  },
};

const order = (i, extra = {}) => ({
  id: 1000 + i,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString(),
  items: [{ id: 7, name: 'Товар', price: 100, qty: 1 }],
  total: 100, subtotal: 100, promo: null,
  customer: { name: 'Клиент ' + i, phone: '+7900' + i },
  user: null, status: 'new',
  ...extra,
});

for (const [name, make] of Object.entries(BACKENDS)) {
  test(`[${name}] документы читаются и пишутся`, () => {
    const { store } = make();
    assert.deepStrictEqual(store.read('products', []), [], 'пустое умолчание');
    store.write('products', [{ id: 1, name: 'Кружка' }]);
    assert.strictEqual(store.read('products', [])[0].name, 'Кружка');
    store.write('products', []);
    assert.deepStrictEqual(store.read('products', []), []);
  });

  test(`[${name}] документы переживают переоткрытие хранилища`, async () => {
    const { store } = make();
    store.write('settings', { brand: { shopName: 'ТЕСТ' } });
    await store.flush();
    // читаем заново тем же бэкендом, но новым экземпляром — данные на месте
    const again = name === 'file'
      ? createStore(store.DATA_DIR)
      : createSqliteStore({ db: store.db, imgDir: store.IMG_DIR });
    assert.strictEqual(again.read('settings', {}).brand.shopName, 'ТЕСТ');
  });

  test(`[${name}] заказы добавляются и находятся`, () => {
    const { orders } = make();
    orders.add(order(1));
    orders.add(order(2));
    assert.strictEqual(orders.stats().total, 2);
    assert.strictEqual(orders.find(1001).customer.name, 'Клиент 1');
    assert.strictEqual(orders.find(999999), null);
  });

  test(`[${name}] список отсортирован от новых к старым`, () => {
    const { orders } = make();
    for (let i = 0; i < 5; i++) orders.add(order(i));
    assert.deepStrictEqual(orders.list({ limit: 3 }).items.map(o => o.id), [1004, 1003, 1002]);
  });

  test(`[${name}] страницы и признак «есть ещё»`, () => {
    const { orders } = make();
    for (let i = 0; i < 10; i++) orders.add(order(i));
    const p1 = orders.list({ offset: 0, limit: 4 });
    assert.strictEqual(p1.items.length, 4);
    assert.strictEqual(p1.total, 10);
    assert.strictEqual(p1.hasMore, true);
    const p3 = orders.list({ offset: 8, limit: 4 });
    assert.strictEqual(p3.items.length, 2);
    assert.strictEqual(p3.hasMore, false);
  });

  test(`[${name}] фильтр по статусу и счётчики`, () => {
    const { orders } = make();
    for (let i = 0; i < 6; i++) orders.add(order(i));
    orders.setStatus(1000, 'done');
    orders.setStatus(1003, 'done');
    orders.setStatus(1005, 'cancelled');

    const done = orders.list({ status: 'done', limit: 50 });
    assert.strictEqual(done.total, 2);
    assert.deepStrictEqual(done.items.map(o => o.id).sort(), [1000, 1003]);

    const st = orders.stats();
    assert.strictEqual(st.byStatus.done, 2);
    assert.strictEqual(st.byStatus.cancelled, 1);
    assert.strictEqual(st.byStatus.new, 3);
  });

  test(`[${name}] выручка без отменённых`, () => {
    const { orders } = make();
    orders.add(order(1, { total: 500 }));
    orders.add(order(2, { total: 300 }));
    orders.add(order(3, { total: 999, status: 'cancelled' }));
    assert.strictEqual(orders.stats().revenue, 800);
    assert.strictEqual(orders.stats().total, 3);
  });

  test(`[${name}] неизвестный статус отвергается`, () => {
    const { orders } = make();
    orders.add(order(1));
    assert.strictEqual(orders.setStatus(1001, 'кое-как'), null);
    assert.strictEqual(orders.find(1001).status, 'new');
  });

  test(`[${name}] частичное обновление не теряет остальные поля`, () => {
    const { orders } = make();
    orders.add(order(1));
    orders.update(1001, { paid: true, paidAt: '2026-01-01T00:00:00.000Z' });
    const o = orders.find(1001);
    assert.strictEqual(o.paid, true);
    assert.strictEqual(o.customer.name, 'Клиент 1', 'покупатель должен остаться');
    assert.strictEqual(o.items.length, 1, 'состав должен остаться');
  });

  test(`[${name}] заказ без статуса считается новым`, () => {
    const { orders } = make();
    const legacy = order(1);
    delete legacy.status;
    orders.add(legacy);
    assert.strictEqual(orders.find(1001).status, 'new');
  });

  test(`[${name}] очистка стирает всё`, () => {
    const { orders } = make();
    for (let i = 0; i < 5; i++) orders.add(order(i));
    orders.clearAll();
    assert.strictEqual(orders.stats().total, 0);
    assert.strictEqual(orders.list({}).items.length, 0);
  });

  test(`[${name}] выгрузка CSV одинакова по формату`, () => {
    const { orders } = make();
    orders.add(order(1));
    const csv = orders.toCSV(orders.all(), {
      advanced: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
      commerce: { currency: '₽' },
    });
    // BOM проверяем по коду символа, а не невидимым литералом в исходнике —
    // такой литерал легко потерять при любой правке файла и не заметить.
    assert.strictEqual(csv.codePointAt(0), 0xfeff, 'CSV обязан начинаться с BOM');
    assert.ok(csv.slice(1).split('\r\n')[0].startsWith('Номер;Дата;Статус;'));
    assert.ok(csv.includes('Клиент 1'));
  });

  test(`[${name}] картинки сохраняются и защищены от ../`, async () => {
    const { store } = make();
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const id = await store.saveImage('image/png', png);
    assert.ok(store.imagePath(id), 'своя картинка находится');
    assert.strictEqual(store.imagePath('../settings.json'), null, 'выход из папки запрещён');
    await store.deleteImage(id);
    assert.strictEqual(store.imagePath(id), null, 'после удаления не находится');
  });
}

// ---------- различия, которые допустимы и осознанны ----------

test('[sqlite] два заказа в одну миллисекунду не затирают друг друга', () => {
  const { orders } = BACKENDS.sqlite();
  const at = new Date().toISOString();
  const a = orders.add({ id: 5000, at, items: [], total: 1, customer: { name: 'Первый' }, status: 'new' });
  const b = orders.add({ id: 5000, at, items: [], total: 2, customer: { name: 'Второй' }, status: 'new' });
  assert.strictEqual(a.id, 5000);
  assert.strictEqual(b.id, 5001, 'номер сдвигается, заказ не теряется');
  assert.strictEqual(orders.stats().total, 2);
  assert.strictEqual(orders.find(5000).customer.name, 'Первый');
  assert.strictEqual(orders.find(5001).customer.name, 'Второй');
});

test('[file] архив существует, в sqlite он не нужен', () => {
  const { orders } = BACKENDS.file();
  for (let i = 0; i < orders.HOT_LIMIT + 3; i++) orders.add(order(i));
  assert.strictEqual(orders.stats().archived, 3, 'файловый бэкенд вытесняет в архив');

  const sql = BACKENDS.sqlite();
  for (let i = 0; i < 5; i++) sql.orders.add(order(i));
  assert.strictEqual(sql.orders.stats().archived, 0, 'в таблице все заказы равноправны');
});
