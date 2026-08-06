'use strict';
// Смысл этапа в одном файле: два магазина живут в одном процессе и ничего
// друг о друге не знают. Раньше это было физически невозможно — DATA_DIR,
// токен бота и курсор опроса лежали на уровне модулей, то есть «процесс»
// и «магазин» были одним и тем же.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { createTenant } = require('../server/tenant');

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-' + name + '-'));

function twoShops() {
  return [
    createTenant({
      id: 'alpha', dataDir: tmp('alpha'),
      botToken: '111:AAA', adminToken: 'пароль-альфы',
      publicUrl: 'https://alpha.example.com/',
    }),
    createTenant({
      id: 'beta', dataDir: tmp('beta'),
      botToken: '222:BBB', adminToken: 'password-beta',
      publicUrl: 'https://beta.example.com',
    }),
  ];
}

test('у магазинов раздельные данные', () => {
  const [a, b] = twoShops();

  a.store.write('products', [{ id: 1, name: 'Кружка альфы' }]);
  b.store.write('products', [{ id: 2, name: 'Плед беты' }, { id: 3, name: 'Ещё' }]);

  assert.strictEqual(a.store.read('products', []).length, 1);
  assert.strictEqual(b.store.read('products', []).length, 2);
  assert.strictEqual(a.store.read('products', [])[0].name, 'Кружка альфы');
});

test('настройки не протекают между магазинами', () => {
  const [a, b] = twoShops();

  a.store.write('settings', { brand: { shopName: 'АЛЬФА' } });
  b.store.write('settings', { brand: { shopName: 'БЕТА' } });

  assert.strictEqual(a.settings().brand.shopName, 'АЛЬФА');
  assert.strictEqual(b.settings().brand.shopName, 'БЕТА');
  // и дефолты каждый достраивает себе сам
  assert.strictEqual(a.settings().commerce.currency, '₽');
});

test('заказы у каждого свои', () => {
  const [a, b] = twoShops();
  const order = i => ({ id: i, at: new Date().toISOString(), items: [], total: i * 100, customer: {}, status: 'new' });

  a.orders.add(order(1));
  a.orders.add(order(2));
  b.orders.add(order(3));

  assert.strictEqual(a.orders.stats().total, 2);
  assert.strictEqual(b.orders.stats().total, 1);
  assert.strictEqual(a.orders.find(3), null, 'чужой заказ находиться не должен');
  assert.ok(b.orders.find(3), 'а свой — должен');
});

test('пароли админок различаются и не совпадают между собой', () => {
  const [a, b] = twoShops();
  assert.notStrictEqual(a.adminHash.toString('hex'), b.adminHash.toString('hex'));
  // тот же пароль у другого магазина даёт тот же дайджест — сверка честная
  const c = createTenant({ id: 'c', dataDir: tmp('c'), adminToken: 'пароль-альфы' });
  assert.strictEqual(a.adminHash.toString('hex'), c.adminHash.toString('hex'));
});

test('токены ботов и секреты вебхуков независимы', () => {
  const [a, b] = twoShops();
  assert.strictEqual(a.telegram.BOT_TOKEN, '111:AAA');
  assert.strictEqual(b.telegram.BOT_TOKEN, '222:BBB');
  assert.notStrictEqual(a.bot.webhookSecret(), b.bot.webhookSecret(),
    'одинаковый секрет позволил бы слать апдейты одного магазина в другой');
});

test('публичный адрес чистится от хвостового слэша у каждого свой', () => {
  const [a, b] = twoShops();
  assert.strictEqual(a.publicUrl, 'https://alpha.example.com');
  assert.strictEqual(b.publicUrl, 'https://beta.example.com');
});

test('ссылка мини-аппа берётся из своих настроек', () => {
  const [a, b] = twoShops();
  a.store.write('settings', { channel: { miniAppLink: 'https://t.me/alphabot/shop' } });
  b.store.write('settings', {});
  assert.strictEqual(a.bot.shopWebAppUrl(a.settings()), 'https://t.me/alphabot/shop');
  // у беты ссылки нет — откатывается на свой публичный адрес, а не на чужой
  assert.strictEqual(b.bot.shopWebAppUrl(b.settings()), 'https://beta.example.com');
});

test('картинки лежат в своей папке', async () => {
  const [a, b] = twoShops();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const id = await a.store.saveImage('image/png', png);
  assert.ok(a.store.imagePath(id), 'своя картинка находится');
  assert.strictEqual(b.store.imagePath(id), null, 'чужая — нет');
});
