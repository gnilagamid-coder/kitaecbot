'use strict';
// Тесты хранения заказов: архив, страницы, статусы, выгрузка.
// DATA_DIR подменяем ДО require('../server/orders') — store.js читает его
// на загрузке модуля и сразу создаёт папку.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../server/store');
const { createOrders, _internal } = require('../server/orders');

// Свой экземпляр хранилища во временной папке: никакого глобального состояния,
// тесты можно гонять параллельно и в любом порядке.
const orders = createOrders(createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-orders-'))));

const SETTINGS = {
  advanced: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
  commerce: { currency: '₽' },
};

function makeOrder(i, extra = {}) {
  return {
    id: 1000 + i,
    at: new Date(Date.UTC(2026, 0, 1, 12, 0, i % 60)).toISOString(),
    items: [{ id: 1, name: 'Товар', price: 100, qty: 1 }],
    total: 100, subtotal: 100, promo: null,
    customer: { name: 'Клиент ' + i },
    user: null, status: 'new',
    ...extra,
  };
}

test('заказы сверх горячего лимита уезжают в архив, а не пропадают', () => {
  orders.clearAll();
  const n = orders.HOT_LIMIT + 100;
  for (let i = 0; i < n; i++) orders.add(makeOrder(i));

  const st = orders.stats();
  assert.strictEqual(st.total, n, 'ни один заказ не должен потеряться');
  assert.strictEqual(st.archived, 100, 'в архив уходит ровно переполнение');

  // самый первый заказ обязан находиться — именно он раньше стирался молча
  const first = orders.find(1000);
  assert.ok(first, 'первый заказ должен быть доступен после переполнения');
  assert.strictEqual(first.customer.name, 'Клиент 0');
});

test('порядок сохраняется: новые впереди, включая границу архива', () => {
  orders.clearAll();
  for (let i = 0; i < orders.HOT_LIMIT + 10; i++) orders.add(makeOrder(i));
  const page = orders.list({ offset: 0, limit: 3 });
  assert.deepStrictEqual(page.items.map(o => o.id), [1509, 1508, 1507]);

  // страница, пересекающая границу горячего файла и архива
  const edge = orders.list({ offset: orders.HOT_LIMIT - 1, limit: 3 });
  assert.deepStrictEqual(edge.items.map(o => o.id), [1010, 1009, 1008]);
});

test('страницы и признак «есть ещё»', () => {
  orders.clearAll();
  for (let i = 0; i < 10; i++) orders.add(makeOrder(i));
  const p1 = orders.list({ offset: 0, limit: 4 });
  assert.strictEqual(p1.items.length, 4);
  assert.strictEqual(p1.total, 10);
  assert.strictEqual(p1.hasMore, true);
  const p3 = orders.list({ offset: 8, limit: 4 });
  assert.strictEqual(p3.items.length, 2);
  assert.strictEqual(p3.hasMore, false);
});

test('статус меняется и у архивного заказа', () => {
  orders.clearAll();
  for (let i = 0; i < orders.HOT_LIMIT + 5; i++) orders.add(makeOrder(i));
  const archived = 1000; // самый старый, уже в архиве
  const updated = orders.setStatus(archived, 'shipped');
  assert.ok(updated, 'архивный заказ должен находиться');
  assert.strictEqual(updated.status, 'shipped');
  assert.strictEqual(orders.find(archived).status, 'shipped', 'изменение должно сохраниться');
});

test('неизвестный статус отвергается', () => {
  orders.clearAll();
  orders.add(makeOrder(1));
  assert.strictEqual(orders.setStatus(1001, 'выполнено-как-нибудь'), null);
  assert.strictEqual(orders.find(1001).status, 'new');
});

test('заказы без поля status считаются новыми', () => {
  orders.clearAll();
  const legacy = makeOrder(1);
  delete legacy.status;
  orders.add(legacy);
  assert.strictEqual(orders.list({}).items[0].status, 'new');
});

test('выручка не учитывает отменённые заказы', () => {
  orders.clearAll();
  orders.add(makeOrder(1, { total: 500 }));
  orders.add(makeOrder(2, { total: 300 }));
  orders.add(makeOrder(3, { total: 999, status: 'cancelled' }));
  const st = orders.stats();
  assert.strictEqual(st.revenue, 800, 'отменённый заказ не попадает в сумму');
  assert.strictEqual(st.byStatus.cancelled, 1);
  assert.strictEqual(st.total, 3, 'но из общего счётчика не исчезает');
});

test('фильтр по статусу видит и архив', () => {
  orders.clearAll();
  for (let i = 0; i < orders.HOT_LIMIT + 5; i++) orders.add(makeOrder(i));
  orders.setStatus(1000, 'done');   // в архиве
  orders.setStatus(1504, 'done');   // в горячем
  const res = orders.list({ status: 'done', limit: 50 });
  assert.strictEqual(res.total, 2);
  assert.deepStrictEqual(res.items.map(o => o.id).sort(), [1000, 1504]);
});

test('CSV: BOM, разделитель и заголовок', () => {
  orders.clearAll();
  orders.add(makeOrder(1));
  const csv = orders.toCSV(orders.all(), SETTINGS);
  assert.ok(csv.startsWith('﻿'), 'без BOM Excel открывает UTF-8 как cp1251');
  const head = csv.slice(1).split('\r\n')[0];
  assert.ok(head.startsWith('Номер;Дата;Статус;Оплачен;'), head);
  assert.ok(head.includes('Итого, ₽'), 'символ валюты берётся из настроек');
});

test('CSV: кавычки, разделители и переносы внутри полей не ломают колонки', () => {
  orders.clearAll();
  orders.add(makeOrder(1, {
    customer: { name: 'Иванов; Пётр', comment: 'скажите «да»\nи ещё "это"', address: 'Москва' },
  }));
  const line = orders.toCSV(orders.all(), SETTINGS).split('\r\n')[1];
  assert.ok(line.includes('"Иванов; Пётр"'), 'поле с разделителем берётся в кавычки');
  assert.ok(line.includes('""это""'), 'кавычка внутри поля удваивается');
  // перенос строки остаётся внутри закавыченного поля — это корректный CSV
  assert.strictEqual((line.match(/"/g) || []).length % 2, 0, 'кавычки должны быть парными');
});

test('CSV: дробные числа в русской локали пишутся с запятой', () => {
  const { csvNumber } = _internal;
  assert.strictEqual(csvNumber(1234.5, 'ru-RU'), '1234,50');
  assert.strictEqual(csvNumber(1234, 'ru-RU'), '1234', 'целые без хвоста');
  assert.strictEqual(csvNumber(1234.5, 'en-US'), '1234.50');
});

test('очистка стирает и архив тоже', () => {
  orders.clearAll();
  for (let i = 0; i < orders.HOT_LIMIT + 10; i++) orders.add(makeOrder(i));
  orders.clearAll();
  const st = orders.stats();
  assert.strictEqual(st.total, 0);
  assert.strictEqual(st.archived, 0);
});
