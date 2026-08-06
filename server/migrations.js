'use strict';
// Миграции MySQL. Файлы .sql лежат в server/migrations и применяются строго
// по алфавиту имени (поэтому именуем с числовым префиксом: 0001_..., 0002_...).
// Каждая применённая миграция фиксируется в служебной таблице schema_migrations
// вместе с sha256-контентом файла — это позволяет:
//   1) не применять одно и то же дважды (идемпотентность);
//   2) поймать «кто-то поменял уже применённый файл» (контрольная сумма).
//
// ВАЖНО про MySQL: DDL (CREATE TABLE и т.п.) здесь НЕ транзакционен — MySQL
// делает неявный COMMIT на каждом DDL. Поэтому миграции пишутся идемпотентными
// (IF NOT EXISTS) и по одной операции, чтобы повторный прогон после сбоя был
// безопасен. DML-миграции (вставка данных) оборачиваем в транзакцию.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function createMigrator({ db, dir = path.join(__dirname, 'migrations') }) {
  async function ensureTable() {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // Режем файл на отдельные операторы по «;» в конце строки. Этого достаточно
  // для DDL/DML без BEGIN...END-блоков хранимых процедур, которые мы не пишем.
  // Однострочные комментарии выкидываем до нарезки: MySQL принимает «-- »
  // только с пробелом, проще не полагаться.
  function splitStatements(sql) {
    const clean = sql.split(/\r?\n/)
      .filter(l => !/^\s*--/.test(l))
      .join('\n');
    return clean
      .split(/;\s*(?:\r?\n|$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  function pendingFiles() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
  }

  async function applied() {
    const [rows] = await db.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name');
    const map = new Map();
    for (const r of rows) map.set(r.name, r.checksum);
    return map;
  }

  // Статус: что применено, что ожидает, и есть ли расхождение контрольных сумм.
  async function status() {
    await ensureTable();
    const done = await applied();
    const files = pendingFiles();
    const out = [];
    for (const f of files) {
      const checksum = sha256(fs.readFileSync(path.join(dir, f)));
      const state = !done.has(f)
        ? 'pending'
        : done.get(f) === checksum ? 'applied' : 'checksum_mismatch';
      out.push({ name: f, state });
    }
    return out;
  }

  // Применить все ожидающие миграции. Возвращает список применённых имён.
  async function up() {
    await ensureTable();
    const done = await applied();
    const appliedNow = [];

    for (const f of pendingFiles()) {
      const raw = fs.readFileSync(path.join(dir, f));
      const checksum = sha256(raw);

      if (done.has(f)) {
        if (done.get(f) !== checksum) {
          throw new Error(
            `миграция ${f} уже применена, но файл изменился ` +
            `(было ${done.get(f).slice(0, 8)}, стало ${checksum.slice(0, 8)}). ` +
            'Править применённые миграции нельзя — добавьте новую.');
        }
        continue;
      }

      const statements = splitStatements(raw.toString('utf8'));
      // Каждая миграция идёт на своём соединении в транзакции там, где это
      // возможно; DDL всё равно закоммитится неявно, но DML-часть защищена.
      await db.tx(async conn => {
        for (const stmt of statements) {
          await conn.query(stmt);
        }
        await conn.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
          [f, checksum]);
      });
      appliedNow.push(f);
    }
    return appliedNow;
  }

  return { up, status, ensureTable, pendingFiles };
}

module.exports = { createMigrator };
