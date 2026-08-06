'use strict';
// Хранилище на MySQL для режима платформы (MULTITENANT=1).
//
// Интерфейс повторяет createStore из store.js, чтобы обработчики в index.js
// не заметили подмены: документы магазина (settings, products, orders, views,
// users…) — строки таблицы shop_docs, чтение синхронное из кэша в памяти,
// запись — в кэш сразу и в MySQL последовательной очередью UPSERT.
//
// Картинки пока остаются на диске (папка магазина) — их отдаёт тот же
// файловый слой, что и createStore. Переезд картинок в БД — следующий шаг.

const { createStore } = require('./store');

const UPSERT = 'INSERT INTO shop_docs (shop_id, doc, data) VALUES (?, ?, ?) '
  + 'AS new ON DUPLICATE KEY UPDATE data = new.data';

function parseDoc(raw) {
  // mysql2 сам парсит колонку JSON в объект; строка придёт только при ручном SELECT CAST'ом
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function createDbStore({ db, shopId, dataDir }) {
  if (!db) throw new Error('store-db: не задан db');
  if (!shopId) throw new Error('store-db: не задан shopId');

  // Файловый стор — только ради картинок и папок; его read/write не трогаем.
  const files = createStore(dataDir);

  const cache = new Map();
  let writeChain = Promise.resolve();

  async function load() {
    const [rows] = await db.query('SELECT doc, data FROM shop_docs WHERE shop_id = ?', [shopId]);
    cache.clear();
    for (const r of rows) cache.set(r.doc, parseDoc(r.data));
  }

  // Стартовый снимок документов. Вызывается до возврата фабрики, чтобы
  // дальше read() был честным синхронным, как в файловом сторе.
  await load();

  function read(key, fallback) {
    return cache.has(key) ? cache.get(key) : fallback;
  }

  function write(key, value) {
    cache.set(key, value);
    // Очередь, как в store.js: параллельные сохранения не должны interleaved'ом
    // записывать один документ в два UPSERT с непредсказуемым порядком.
    writeChain = writeChain.then(() =>
      db.query(UPSERT, [shopId, String(key), JSON.stringify(value)])
    ).catch(err => console.error('[store-db] write failed', key, err.message));
    return writeChain;
  }

  const flush = () => writeChain;

  // Перечитать документы из БД. Нужно, если данные подменили снаружи
  // (миграция, ручная правка) — кэш в памяти перестаёт быть владельцем.
  const reload = () => load();

  return {
    read, write,
    saveImage: files.saveImage,
    imagePath: files.imagePath,
    deleteImage: files.deleteImage,
    flush, reload,
    DATA_DIR: files.DATA_DIR,
    IMG_DIR: files.IMG_DIR,
    kind: 'db',
    shopId,
  };
}

module.exports = { createDbStore };
