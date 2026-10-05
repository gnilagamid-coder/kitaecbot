// Склейка записей и версии документов в файловом хранилище.
//
// Серия записей одного ключа (просмотры товара, корзины в чате) не должна
// превращаться в серию перезаписей файла: на диск ложится последнее значение,
// а число реальных записей — единицы. Версия документа растёт на каждую
// запись — по ней пересобираются кэши настроек, витрины и ответов API.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../server/store');
const { createTenant } = require('../server/tenant');

test('100 записей подряд — одна-две перезаписи файла, на диске последнее значение', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-coalesce-'));
  try {
    const store = createStore(dir);
    const realWrite = fsp.writeFile;
    let writes = 0;
    fsp.writeFile = async (...args) => {
      if (String(args[0]).includes('views.json')) writes++;
      return realWrite(...args);
    };
    try {
      for (let i = 1; i <= 100; i++) store.write('views', { 42: i });
      await store.flush();
    } finally {
      fsp.writeFile = realWrite;
    }
    assert.ok(writes <= 2, `перезаписей файла: ${writes}`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'views.json'), 'utf8')), { 42: 100 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('запись после начала предыдущей не теряется', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-coalesce-'));
  try {
    const store = createStore(dir);
    store.write('chats', { a: 1 });
    await new Promise(r => setImmediate(r)); // первая запись уже пошла на диск
    store.write('chats', { a: 2 });
    await store.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')), { a: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('версия документа растёт на запись и при reload; настройки пересчитываются по ней', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-coalesce-'));
  try {
    const shop = createTenant({ dataDir: dir, adminToken: 'x' });
    const v0 = shop.store.version('settings');
    const a = shop.settings();
    assert.strictEqual(shop.settings(), a, 'без записи — тот же объект, нормализация не повторяется');

    shop.store.write('settings', { brand: { shopName: 'Новое имя' } });
    assert.notStrictEqual(shop.store.version('settings'), v0);
    assert.strictEqual(shop.settings().brand.shopName, 'Новое имя', 'после записи — свежие настройки');

    const v1 = shop.store.version('settings');
    shop.store.reload();
    assert.notStrictEqual(shop.store.version('settings'), v1, 'reload меняет версию');
    await shop.store.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
