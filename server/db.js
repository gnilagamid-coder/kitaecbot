'use strict';
// Подключение к SQLite и накат миграций.
//
// Почему SQLite, а не отдельный сервер базы: после перехода на один процесс,
// обслуживающий все магазины, главный аргумент за PostgreSQL — конкурентная
// запись из нескольких процессов — исчезает. Остаётся файл, который бэкапится
// копированием, не требует установки и обслуживания и умеет транзакции,
// уникальные индексы и откат. Когда упрёмся в горизонтальное масштабирование
// или понадобится восстановление на точку во времени, бэкенд меняется одним
// новым файлом: хранилище уже за интерфейсом.
//
// node:sqlite встроен в Node и зависимостей не добавляет, но появился в 22.5
// и работает без флага с 23.4. Поэтому require ленивый: на Node 20 файловый
// бэкенд обязан продолжать работать, а не падать при загрузке модуля.

const { MIGRATIONS } = require('./migrations');

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function requireSqlite() {
  try {
    return require('node:sqlite');
  } catch (e) {
    throw new Error(
      'Бэкенд sqlite требует Node 22.5+ (без флага — с 23.4). ' +
      `Текущая версия ${process.version}. Обновите Node или оставьте STORE_BACKEND=file.`
    );
  }
}

function openDb(file) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(file);
  // WAL: читатели не блокируют писателя — витрина продолжает отдавать каталог,
  // пока сохраняется заказ.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL вместо FULL: на порядок меньше fsync при той же устойчивости к
  // падению процесса. Питание всё же лучше не выдёргивать.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Если кто-то всё-таки держит запись (например, скрипт миграции), ждём,
  // а не падаем сразу с SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function currentVersion(db) {
  db.exec(MIGRATIONS_TABLE);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return (row && row.v) || 0;
}

function appliedVersions(db) {
  db.exec(MIGRATIONS_TABLE);
  return db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
}

// Каждая миграция катится в своей транзакции: если up бросил на середине,
// база остаётся на предыдущей версии целиком, а не в половинчатом состоянии.
function runOne(db, m, direction) {
  db.exec('BEGIN');
  try {
    if (direction === 'up') {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    } else {
      if (typeof m.down !== 'function') throw new Error(`миграция ${m.version} (${m.name}) не умеет откатываться`);
      m.down(db);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`миграция ${m.version} (${m.name}) ${direction === 'up' ? 'не накатилась' : 'не откатилась'}: ${e.message}`);
  }
}

// Привести базу к нужной версии. target по умолчанию — самая свежая;
// меньшее число откатывает назад, 0 сносит схему полностью.
function migrate(db, { target = null, migrations = MIGRATIONS, log = () => {} } = {}) {
  db.exec(MIGRATIONS_TABLE);
  const sorted = [...migrations].sort((a, z) => a.version - z.version);
  const latest = sorted.length ? sorted[sorted.length - 1].version : 0;
  const to = target === null ? latest : Number(target);
  const from = currentVersion(db);

  if (to > from) {
    for (const m of sorted) {
      if (m.version > from && m.version <= to) {
        runOne(db, m, 'up');
        log(`[db] миграция ${m.version} (${m.name}) применена`);
      }
    }
  } else if (to < from) {
    for (const m of [...sorted].reverse()) {
      if (m.version <= from && m.version > to) {
        runOne(db, m, 'down');
        log(`[db] миграция ${m.version} (${m.name}) откачена`);
      }
    }
  }

  return { from, to: currentVersion(db) };
}

// Открыть базу и сразу привести к актуальной версии — обычный путь запуска.
function openAndMigrate(file, opts = {}) {
  const db = openDb(file);
  migrate(db, opts);
  return db;
}

module.exports = { openDb, openAndMigrate, migrate, currentVersion, appliedVersions, MIGRATIONS };
