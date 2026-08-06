'use strict';
// Миграции схемы. Каждая — пара up/down с номером версии; номера идут подряд
// и не переиспользуются. Откат обязан работать: если новая версия сломала прод,
// возможность вернуться на шаг назад важнее красоты схемы.
//
// Правило на будущее: уже применённые миграции не редактируются никогда.
// Нужно поправить схему — пишется следующая. Иначе базы, накатившие старую
// версию, и базы, накатившие исправленную, разъедутся молча.

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    up(db) {
      // Документы — то же самое «ключ → JSON», что лежало в файлах: настройки,
      // товары, пользователи бота, счётчики просмотров. Эти сущности всегда
      // читаются и пишутся целиком, дробить их на колонки смысла нет.
      db.exec(`
        CREATE TABLE documents (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      // Заказы — наоборот, настоящая таблица. Их много, они растут без предела,
      // и к ним есть запросы: страница, фильтр по статусу, счётчики, выручка.
      // В файловом бэкенде ради этого приходилось держать «горячий» файл и
      // архив; здесь достаточно индекса.
      //
      // Тело заказа остаётся JSON в doc: состав, покупатель, промокод — это
      // документ, который читается целиком и никогда не запрашивается по частям.
      // В колонки вынесено ровно то, по чему идут запросы.
      db.exec(`
        CREATE TABLE orders (
          id     INTEGER PRIMARY KEY,
          at     TEXT    NOT NULL,
          status TEXT    NOT NULL DEFAULT 'new',
          paid   INTEGER NOT NULL DEFAULT 0,
          total  REAL    NOT NULL DEFAULT 0,
          doc    TEXT    NOT NULL
        )
      `);
      db.exec('CREATE INDEX orders_at_idx ON orders(at DESC)');
      db.exec('CREATE INDEX orders_status_idx ON orders(status, at DESC)');
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS orders_status_idx');
      db.exec('DROP INDEX IF EXISTS orders_at_idx');
      db.exec('DROP TABLE IF EXISTS orders');
      db.exec('DROP TABLE IF EXISTS documents');
    },
  },
];

module.exports = { MIGRATIONS };
