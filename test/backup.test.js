'use strict';
// Бэкапы — место, где ошибка стоит всех данных магазина. Проверяем полный цикл:
// снимок -> целостность -> восстановление -> планировщик -> скачивание.

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../server/store');
const { createBackupManager, clampConfig } = require('../server/backup');

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-' + name + '-'));

// Фабрика менеджера на временной папке. now() инъектируем, чтобы имена снимков
// (это дата) были детерминированными и не сталкивались в одну секунду.
function setup({ t0 = Date.parse('2026-08-06T10:00:00Z') } = {}) {
  const dataDir = tmp('data');
  const backupsRoot = tmp('backups');
  const store = createStore(dataDir);
  let clock = t0;
  const mgr = createBackupManager({
    dataDir, backupsRoot, tenantId: 'shop', store,
    now: () => clock,
  });
  return { dataDir, backupsRoot, store, mgr, advance: ms => { clock += ms; } };
}

async function seed(store) {
  store.write('products', [{ id: 1, name: 'Кружка', price: 500 }]);
  store.write('settings', { brand: { shopName: 'ТЕСТ' } });
  await fsp.writeFile(path.join(store.IMG_DIR, 'img_test.png'), Buffer.from('PNG-BYTES'));
  await store.flush();
}

test('снимок копирует JSON и картинки, пишет манифест, конфиг не включает', async () => {
  const { dataDir, store, mgr } = await setup();
  await seed(store);
  await mgr.updateConfig({ enabled: true, retention: 5 });

  const snap = await mgr.runNow('manual');
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(snap.name));

  const dir = path.join(mgr.ROOT, snap.name);
  const products = JSON.parse(await fsp.readFile(path.join(dir, 'products.json'), 'utf8'));
  assert.strictEqual(products[0].name, 'Кружка');
  const img = await fsp.readFile(path.join(dir, 'images', 'img_test.png'), 'utf8');
  assert.strictEqual(img, 'PNG-BYTES');

  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const paths = manifest.files.map(f => f.path).sort();
  assert.deepStrictEqual(paths, ['images/img_test.png', 'products.json', 'settings.json']);
  // конфиг бэкапов в снимок не попадает: восстановление не должно его откатывать
  assert.ok(!paths.includes('backup-config.json'));
  assert.ok(manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));

  // lastRunAt обновлён
  assert.strictEqual(mgr.getConfig().lastRunAt, snap.createdAt);
});

test('verify ловит испорченный снимок, восстановление из него отвергается', async () => {
  const { store, mgr } = await setup();
  await seed(store);
  const snap = await mgr.runNow('manual');

  // портим один файл в снимке
  const victim = path.join(mgr.ROOT, snap.name, 'products.json');
  await fsp.writeFile(victim, 'БИТЫЕ ДАННЫЕ');

  const v = await mgr.verify(snap.name);
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.bad, ['products.json']);

  await assert.rejects(() => mgr.restore(snap.name), /испорчен/);
});

test('восстановление откатывает данные и сбрасывает кэш store', async () => {
  const { dataDir, store, mgr } = await setup();
  await seed(store);
  const snap = await mgr.runNow('manual');

  // жизнь после снимка: товары поменяли, картинку удалили, добавили новую
  store.write('products', [{ id: 2, name: 'Другой товар', price: 999 }]);
  await store.flush();
  await fsp.rm(path.join(store.IMG_DIR, 'img_test.png'));
  await fsp.writeFile(path.join(store.IMG_DIR, 'img_new.png'), Buffer.from('NEW'));

  await mgr.restore(snap.name);

  // кэш сброшен — read видит восстановленное с диска
  assert.strictEqual(store.read('products', [])[0].name, 'Кружка');
  assert.ok(fs.existsSync(path.join(store.IMG_DIR, 'img_test.png')), 'старая картинка вернулась');
  assert.ok(!fs.existsSync(path.join(store.IMG_DIR, 'img_new.png')), 'картинка после снимка убрана');

  // конфиг бэкапов пережил восстановление: lastRunAt остался от снимка,
  // а не стёрся вместе с остальными JSON
  assert.strictEqual(mgr.getConfig().lastRunAt, snap.createdAt);
  assert.ok(fs.existsSync(path.join(dataDir, 'backup-config.json')));
});

test('retention хранит только N последних снимков', async () => {
  const { store, mgr, advance } = await setup();
  await seed(store);
  await mgr.updateConfig({ retention: 2 });

  const names = [];
  for (let i = 0; i < 4; i++) {
    advance(3600 * 1000); // каждый снимок — через час, имена не сталкиваются
    names.push((await mgr.runNow('manual')).name);
  }
  const left = (await mgr.list()).map(s => s.name);
  assert.deepStrictEqual(left, [names[3], names[2]]);
});

test('clampConfig не пускает мусорные значения', () => {
  assert.deepStrictEqual(clampConfig({}), { enabled: false, intervalHours: 24, retention: 10 });
  assert.deepStrictEqual(
    clampConfig({ enabled: 1, intervalHours: 99999, retention: '0' }),
    { enabled: true, intervalHours: 720, retention: 1 }
  );
  assert.deepStrictEqual(
    clampConfig({ intervalHours: -5, retention: 1000 }),
    { enabled: false, intervalHours: 1, retention: 100 }
  );
});

test('планировщик снимает по интервалу и не дублирует раньше времени', async () => {
  const { store, mgr, advance } = await setup();
  await seed(store);

  // выключен — ничего не делает
  await mgr.tick();
  assert.strictEqual((await mgr.list()).length, 0);

  await mgr.updateConfig({ enabled: true, intervalHours: 24 });
  await mgr.tick(); // lastRunAt пуст — первый снимок положен сразу
  assert.strictEqual((await mgr.list()).length, 1);

  await mgr.tick(); // прошло 0 часов из 24 — второго не будет
  assert.strictEqual((await mgr.list()).length, 1);

  advance(24 * 3600 * 1000);
  await mgr.tick();
  assert.strictEqual((await mgr.list()).length, 2);
});

test('скачивание отдаёт валидный gzip с ustar-внутренностями', async () => {
  const { store, mgr } = await setup();
  await seed(store);
  const snap = await mgr.runNow('manual');

  const gz = await mgr.archive(snap.name);
  assert.strictEqual(gz[0], 0x1f); // магические байты gzip
  assert.strictEqual(gz[1], 0x8b);

  const tar = zlib.gunzipSync(gz);
  assert.ok(tar.includes('ustar'), 'внутри ustar-заголовки');
  assert.ok(tar.includes(`${snap.name}/products.json`));
  assert.ok(tar.includes(`${snap.name}/images/img_test.png`));
  // конец архива — два пустых блока по 512 байт
  assert.ok(tar.subarray(tar.length - 1024).every(b => b === 0));
  assert.strictEqual(tar.length % 512, 0);
});

test('имя снимка с попыткой выхода за пределы ROOT отвергается', async () => {
  const { store, mgr } = await setup();
  await seed(store);
  await mgr.runNow('manual');

  for (const bad of ['../escape', '2026-08-06_10-00-00/../x', 'latest', '']) {
    await assert.rejects(() => mgr.restore(bad), /неверное имя снимка/);
    await assert.rejects(() => mgr.remove(bad), /неверное имя снимка/);
  }
});

test('у двух магазинов снимки не пересекаются', async () => {
  const backupsRoot = tmp('backups');
  const mk = id => {
    const dataDir = tmp('data-' + id);
    const store = createStore(dataDir);
    return { store, mgr: createBackupManager({ dataDir, backupsRoot, tenantId: id, store }) };
  };
  const a = mk('alpha'), b = mk('beta');
  a.store.write('products', [{ id: 1, name: 'Альфа' }]);
  b.store.write('products', [{ id: 2, name: 'Бета' }]);
  await a.store.flush(); await b.store.flush();

  const sa = await a.mgr.runNow('manual');
  const sb = await b.mgr.runNow('manual');

  const pa = JSON.parse(await fsp.readFile(path.join(a.mgr.ROOT, sa.name, 'products.json'), 'utf8'));
  const pb = JSON.parse(await fsp.readFile(path.join(b.mgr.ROOT, sb.name, 'products.json'), 'utf8'));
  assert.strictEqual(pa[0].name, 'Альфа');
  assert.strictEqual(pb[0].name, 'Бета');
  assert.ok(a.mgr.ROOT !== b.mgr.ROOT);
});
