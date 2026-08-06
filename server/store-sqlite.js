'use strict';
// Хранилище документов поверх SQLite. Интерфейс тот же, что у файлового
// (read / write / картинки / flush), поэтому подменяется целиком и незаметно
// для всего остального кода.
//
// Чем лучше файлового: запись атомарна по-настоящему (транзакция, а не
// «временный файл и rename»), одна база вместо россыпи JSON, и появляется
// место, куда класть то, что в файлах жило плохо, — заказы отдельной таблицей
// с индексами вместо «горячий файл плюс архив».

const path = require('node:path');
const { createImages } = require('./images');

function createSqliteStore({ db, imgDir }) {
  const images = createImages(imgDir);

  // Кэш в памяти, как и в файловом бэкенде. SQLite и так быстрый, но read()
  // зовётся почти на каждый запрос витрины, а документ настроек читается по
  // несколько раз за один рендер страницы — незачем ходить в базу за тем,
  // что не менялось. Единственный писатель — write() ниже, поэтому кэш
  // не может разъехаться с базой.
  const cache = new Map();

  const selectStmt = db.prepare('SELECT value FROM documents WHERE key = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  function read(key, fallback) {
    if (cache.has(key)) return cache.get(key);
    let value = fallback;
    try {
      const row = selectStmt.get(key);
      if (row && row.value != null) value = JSON.parse(row.value);
    } catch (e) {
      // битый JSON в базе — ведём себя как файловый бэкенд: отдаём умолчание,
      // а не роняем магазин целиком
      console.error('[store] не разобрать документ', key, e.message);
      value = fallback;
    }
    cache.set(key, value);
    return value;
  }

  // Возвращает промис для совместимости с файловым бэкендом, где запись
  // асинхронная. Здесь она уже завершена в момент возврата.
  function write(key, value) {
    cache.set(key, value);
    try {
      upsertStmt.run(key, JSON.stringify(value), new Date().toISOString());
    } catch (e) {
      console.error('[store] write failed', key, e.message);
    }
    return Promise.resolve();
  }

  return {
    read, write,
    saveImage: images.saveImage,
    imagePath: images.imagePath,
    deleteImage: images.deleteImage,
    flush: () => Promise.resolve(),
    db,
    DATA_DIR: path.dirname(imgDir),
    IMG_DIR: images.IMG_DIR,
  };
}

module.exports = { createSqliteStore };
