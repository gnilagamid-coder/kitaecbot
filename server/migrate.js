'use strict';
// CLI миграций: node server/migrate.js [up|status]
//   up      — применить все ожидающие миграции (по умолчанию)
//   status  — показать, что применено и что ожидает
// Подключение — из MYSQL_* (.env или окружение). База из MYSQL_DATABASE
// создаётся, если её ещё нет.

require('./env').loadEnv();
const { createDb, dbConfigFromEnv } = require('./db');
const { createMigrator } = require('./migrations');

async function ensureDatabase(cfg) {
  if (!cfg.database) throw new Error('MYSQL_DATABASE не задан');
  // подключение без database, чтобы создать её при отсутствии
  const root = createDb({ ...cfg, database: undefined });
  try {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database.replace(/`/g, '')}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await root.end();
  }
}

async function main() {
  const cmd = process.argv[2] || 'up';
  const cfg = dbConfigFromEnv();
  if (!cfg.host) {
    console.error('MYSQL_HOST не задан — миграции доступны только при настроенной БД.');
    process.exit(1);
  }

  await ensureDatabase(cfg);
  const db = createDb(cfg);
  const migrator = createMigrator({ db });

  try {
    if (cmd === 'status') {
      const rows = await migrator.status();
      if (!rows.length) console.log('файлов миграций нет');
      for (const r of rows) console.log(`${r.state.padEnd(17)} ${r.name}`);
    } else if (cmd === 'up') {
      const applied = await migrator.up();
      console.log(applied.length
        ? `применено: ${applied.join(', ')}`
        : 'новых миграций нет — схема актуальна');
    } else {
      console.error(`неизвестная команда: ${cmd} (up | status)`);
      process.exit(1);
    }
  } finally {
    await db.end();
  }
}

main().catch(e => {
  console.error('[migrate]', e.message);
  process.exit(1);
});
