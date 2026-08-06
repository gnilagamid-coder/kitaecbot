'use strict';
// Миграции: накат, откат, повторный запуск, целостность при падении.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { openDb, migrate, currentVersion, appliedVersions, MIGRATIONS } = require('../server/db');

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-db-')), 'shop.db');
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);

test('чистая база накатывается до последней версии', () => {
  const db = openDb(tmpDb());
  const r = migrate(db);
  assert.strictEqual(r.from, 0);
  assert.strictEqual(r.to, MIGRATIONS[MIGRATIONS.length - 1].version);
  const t = tables(db);
  assert.ok(t.includes('documents'), t.join(','));
  assert.ok(t.includes('orders'), t.join(','));
  assert.ok(t.includes('schema_migrations'), t.join(','));
});

test('повторный накат ничего не делает', () => {
  const db = openDb(tmpDb());
  migrate(db);
  const before = appliedVersions(db);
  const r = migrate(db);
  assert.strictEqual(r.from, r.to, 'версия не должна меняться');
  assert.deepStrictEqual(appliedVersions(db).length, before.length, 'записи не должны задваиваться');
});

test('откат до нуля сносит схему и возвращает версию', () => {
  const db = openDb(tmpDb());
  migrate(db);
  assert.ok(currentVersion(db) > 0);

  migrate(db, { target: 0 });
  assert.strictEqual(currentVersion(db), 0);
  const t = tables(db);
  assert.ok(!t.includes('orders'), 'таблица заказов должна исчезнуть');
  assert.ok(!t.includes('documents'), 'таблица документов должна исчезнуть');
  assert.ok(t.includes('schema_migrations'), 'журнал миграций остаётся — иначе откат не отследить');
});

test('после отката можно накатить заново', () => {
  const db = openDb(tmpDb());
  migrate(db);
  migrate(db, { target: 0 });
  const r = migrate(db);
  assert.strictEqual(r.to, MIGRATIONS[MIGRATIONS.length - 1].version);
  assert.ok(tables(db).includes('orders'));
});

test('журнал миграций пишет имя и время', () => {
  const db = openDb(tmpDb());
  migrate(db);
  const rows = appliedVersions(db);
  assert.strictEqual(rows.length, MIGRATIONS.length);
  assert.strictEqual(rows[0].version, 1);
  assert.strictEqual(rows[0].name, 'initial');
  assert.ok(!Number.isNaN(Date.parse(rows[0].applied_at)), 'время должно разбираться');
});

test('падение внутри миграции откатывает её целиком', () => {
  const db = openDb(tmpDb());
  const broken = [{
    version: 1,
    name: 'broken',
    up(d) {
      d.exec('CREATE TABLE half_done (x TEXT)');
      throw new Error('споткнулись на середине');
    },
    down() {},
  }];
  assert.throws(() => migrate(db, { migrations: broken }), /не накатилась/);
  assert.strictEqual(currentVersion(db), 0, 'версия не должна вырасти');
  assert.ok(!tables(db).includes('half_done'), 'недосозданная таблица должна исчезнуть вместе с транзакцией');
});

test('миграция без down честно ругается, а не делает вид', () => {
  const db = openDb(tmpDb());
  const noDown = [{ version: 1, name: 'no-down', up(d) { d.exec('CREATE TABLE a (x TEXT)'); } }];
  migrate(db, { migrations: noDown });
  assert.throws(() => migrate(db, { migrations: noDown, target: 0 }), /не умеет откатываться/);
});
