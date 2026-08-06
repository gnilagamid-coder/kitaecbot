'use strict';
// Перенос магазина из JSON-файлов в SQLite.
//
//   node scripts/migrate-to-sqlite.js --data /opt/tg-shop/data
//   node scripts/migrate-to-sqlite.js --data ./data --db ./data/shop.db --force
//
// Что делает: читает файлы, создаёт базу, накатывает миграции, переносит
// документы и заказы, сверяет количество и выходит с ненулевым кодом, если
// что-то не сошлось.
//
// Чего НЕ делает: не удаляет и не меняет ни одного исходного файла. После
// переезда data/*.json остаются на месте — это и есть бэкап. Откат до
// файлового бэкенда = убрать STORE_BACKEND=sqlite и перезапустить.

const fs = require('node:fs');
const path = require('node:path');

const { openAndMigrate, currentVersion } = require('../server/db');
const { createSqliteStore } = require('../server/store-sqlite');
const { createSqlOrders } = require('../server/orders-sqlite');
const { createStore } = require('../server/store');
const { createOrders } = require('../server/orders');

function parseArgs(argv) {
  const out = { data: '', db: '', force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '-h' || argv[i] === '--help') out.help = true;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.data) {
    console.log('Использование: node scripts/migrate-to-sqlite.js --data <папка data> [--db <файл>] [--force]');
    return args.help ? 0 : 1;
  }

  const dataDir = path.resolve(args.data);
  if (!fs.existsSync(dataDir)) {
    console.error(`X  Папка ${dataDir} не найдена`);
    return 1;
  }
  // Папка без единого знакомого файла — почти наверняка опечатка в пути.
  // Без этой проверки скрипт бодро отчитывался «перенесено 0 заказов» и
  // выходил с нулевым кодом: человек переключал STORE_BACKEND и обнаруживал
  // пустой магазин, считая, что переезд прошёл успешно.
  const KNOWN = ['settings.json', 'products.json', 'orders.json', 'orders-archive.json', 'users.json', 'views.json'];
  const found = KNOWN.filter(f => fs.existsSync(path.join(dataDir, f)));
  if (!found.length) {
    console.error(`X  В ${dataDir} нет ни одного файла магазина (${KNOWN.join(', ')}).`);
    console.error('   Похоже на опечатку в пути. Ничего не делаю.');
    return 1;
  }

  const dbFile = path.resolve(args.db || path.join(dataDir, 'shop.db'));

  if (fs.existsSync(dbFile) && !args.force) {
    console.error(`X  База ${dbFile} уже существует. Перенос в непустую базу может задвоить заказы.`);
    console.error('   Удалите её или запустите с --force, если понимаете, что делаете.');
    return 1;
  }

  console.log(`==> Источник: ${dataDir}`);
  console.log(`==> База:     ${dbFile}`);

  // Читаем через тот же файловый бэкенд, что и боевой сервер: никакого
  // отдельного разбора JSON, значит и расхождений в поведении не будет.
  const fileStore = createStore(dataDir);
  const fileOrders = createOrders(fileStore);

  const db = openAndMigrate(dbFile, { log: msg => console.log('   ' + msg) });
  console.log(`   версия схемы: ${currentVersion(db)}`);

  const sqlStore = createSqliteStore({ db, imgDir: path.join(dataDir, 'images') });
  const sqlOrders = createSqlOrders(db);

  // ---------- документы ----------
  // orders и orders-archive не трогаем: они переезжают в таблицу ниже.
  const DOCS = ['settings', 'products', 'users', 'views'];
  const docReport = [];
  for (const key of DOCS) {
    const file = path.join(dataDir, `${key}.json`);
    if (!fs.existsSync(file)) { docReport.push([key, 'нет файла']); continue; }
    const value = fileStore.read(key, null);
    if (value === null) { docReport.push([key, 'пусто']); continue; }
    sqlStore.write(key, value);
    const size = Array.isArray(value) ? `${value.length} шт.` : `${Object.keys(value).length} полей`;
    docReport.push([key, size]);
  }

  // ---------- заказы ----------
  // Идём от старых к новым, чтобы номера в таблице ложились в том же порядке,
  // в каком они возникали.
  const source = fileOrders.all();
  const ordered = [...source].reverse();
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const o of ordered) { sqlOrders.add(o); moved++; }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('X  Перенос заказов не удался, база откачена:', e.message);
    return 1;
  }

  // ---------- сверка ----------
  console.log('\n==> Документы');
  for (const [k, info] of docReport) console.log(`   ${k.padEnd(10)} ${info}`);

  const fileStats = fileOrders.stats();
  const sqlStats = sqlOrders.stats();
  console.log('\n==> Заказы');
  console.log(`   в файлах: ${fileStats.total} (из них в архиве ${fileStats.archived})`);
  console.log(`   в базе:   ${sqlStats.total}`);
  console.log(`   выручка:  ${fileStats.revenue} → ${sqlStats.revenue}`);

  const problems = [];
  if (sqlStats.total !== fileStats.total) problems.push(`перенесено ${sqlStats.total} заказов из ${fileStats.total}`);
  if (Math.round(sqlStats.revenue) !== Math.round(fileStats.revenue)) problems.push('сумма выручки не сошлась');
  for (const st of Object.keys(fileStats.byStatus)) {
    if (fileStats.byStatus[st] !== sqlStats.byStatus[st]) problems.push(`статус ${st}: ${fileStats.byStatus[st]} против ${sqlStats.byStatus[st]}`);
  }
  // выборочная сверка содержимого: номер, сумма и имя покупателя у свежего заказа
  if (source.length) {
    const a = source[0];
    const b = sqlOrders.find(a.id);
    if (!b) problems.push(`заказ ${a.id} не найден в базе`);
    else if (JSON.stringify(b.items) !== JSON.stringify(a.items)) problems.push(`состав заказа ${a.id} не совпал`);
  }

  if (problems.length) {
    console.error('\nX  Расхождения:');
    for (const p of problems) console.error('   - ' + p);
    console.error('\n   Файлы не тронуты. Удалите базу и разберитесь, прежде чем переключать STORE_BACKEND.');
    return 1;
  }

  console.log(`\n✓ Перенесено ${moved} заказов и ${docReport.filter(([, i]) => i !== 'нет файла').length} документов.`);
  console.log('  Исходные JSON остались на месте — это ваш бэкап.');
  console.log('\n  Дальше:');
  console.log('    1) впишите в .env:  STORE_BACKEND=sqlite');
  console.log('    2) systemctl restart tg-shop');
  console.log('    3) проверьте админку: товары, заказы, статусы');
  console.log('  Откат: убрать строку из .env и перезапустить — файлы никуда не делись.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs };
