// Биллинг платформы (Stage 5): подписка магазинов через Robokassa.
// Проверяем подписи кассы, счета и продление, пробный период, приостановку
// просроченных магазинов и полный цикл через HTTP: оплата снимает
// приостановку. Биллинг опционален — отдельно проверяем выключенный режим.
// Нужен живой MySQL (MYSQL_* в .env); без него интеграция пропускается.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

require('../server/env').loadEnv();
const { createDb, dbConfigFromEnv } = require('../server/db');
const { createMigrator } = require('../server/migrations');
const { createRegistry } = require('../server/registry');
const { createRobokassa } = require('../server/robokassa');
const { createBilling } = require('../server/billing');

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

// ---------- окружение интеграции ----------
const cfg = dbConfigFromEnv();
const TEST_DB = 'kitaec_bill_' + Math.random().toString(36).slice(2, 8);
const DOMAIN = 'example.test';
const PORT = 5100 + Math.floor(Math.random() * 300);
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-bill-root-'));
const RK = { login: 'e2e-shop', pass1: 'p1-secret', pass2: 'p2-secret' };

let db, root, registry, child;
let available = false;
let platformUp = false;

function spawnPlatform(env) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stderr.on('data', d => { if (process.env.MT_DEBUG) console.error('[child stderr]', String(d)); });
  return c;
}

function waitReady(c) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('платформа не поднялась за 15 секунд')), 15000);
    c.stdout.on('data', d => {
      if (process.env.MT_DEBUG) console.error('[child stdout]', String(d));
      if (String(d).includes('[platform]')) { clearTimeout(timer); resolve(); }
    });
    c.on('exit', code => reject(new Error(`сервер умер при старте (код ${code})`)));
  });
}

const platformEnv = {
  PORT: String(PORT), HOST: '127.0.0.1',
  MULTITENANT: '1', MULTITENANT_DOMAIN: DOMAIN, MULTITENANT_DATA_ROOT: DATA_ROOT,
  MYSQL_DATABASE: TEST_DB, SECRET_KEY: 'billing-test-secret-42',
  ADMIN_TOKEN: '', BOT_TOKEN: '',
};

async function makeShop(subdomain, title) {
  const tenantId = await registry.createTenant({ slug: subdomain, name: title, status: 'trial' });
  const shopId = await registry.createShop({
    tenantId, subdomain, title,
    adminTokenHash: crypto.createHash('sha256').update('x').digest('hex'),
    status: 'active',
  });
  return registry.findShopBySubdomain(subdomain);
}

test.before(async () => {
  if (!cfg.host) return; // БД не настроена — интеграция пропускается
  try {
    root = createDb({ ...cfg, database: undefined });
    await root.query(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = createDb({ ...cfg, database: TEST_DB });
    await createMigrator({ db }).up();
    registry = createRegistry(db);
    available = true;
  } catch (e) {
    available = false;
    return;
  }
  child = spawnPlatform(platformEnv);
  try {
    await waitReady(child);
    platformUp = true;
  } catch (e) {
    console.error('[billing test]', e.message);
    platformUp = false;
  }
});

test.after(async () => {
  if (child) child.kill();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  if (db) await db.end().catch(() => {});
  if (root) {
    if (available) await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``).catch(() => {});
    await root.end().catch(() => {});
  }
});

const skipDb = t => { if (!available) { t.skip('MySQL недоступен'); return true; } return false; };
const skipHttp = t => { if (!platformUp) { t.skip('платформа не поднялась'); return true; } return false; };

// ---------- robokassa: подписи без БД ----------
test('robokassa: ссылка оплаты и подписи сходятся с ручным расчётом', () => {
  const rk = createRobokassa({ login: 'demo', pass1: 'p1', pass2: 'p2', isTest: true });
  const url = rk.payUrl({ amount: 990, invId: 7, description: 'Подписка' });
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('MerchantLogin'), 'demo');
  assert.strictEqual(u.searchParams.get('OutSum'), '990.00');
  assert.strictEqual(u.searchParams.get('InvId'), '7');
  assert.strictEqual(u.searchParams.get('IsTest'), '1');
  assert.strictEqual(u.searchParams.get('SignatureValue').toLowerCase(), md5('demo:990.00:7:p1'));

  // Result — Password2, Success — Password1; регистр подписи не важен.
  assert.ok(rk.verifyResult({ OutSum: '990.00', InvId: '7', SignatureValue: md5('990.00:7:p2').toUpperCase() }));
  assert.ok(!rk.verifyResult({ OutSum: '990.00', InvId: '7', SignatureValue: md5('990.00:7:p1') }), 'Result не принимает Password1');
  assert.ok(rk.verifySuccess({ OutSum: '990.00', InvId: '7', SignatureValue: md5('990.00:7:p1') }));
  // Другая сумма — другая подпись
  assert.ok(!rk.verifyResult({ OutSum: '1.00', InvId: '7', SignatureValue: md5('990.00:7:p2') }));
});

test('robokassa: без паролей фабрика не создаётся', () => {
  assert.throws(() => createRobokassa({ login: 'x' }), /pass1/);
});

// ---------- биллинг на живой БД ----------
function makeBilling(extra = {}) {
  return createBilling({
    db, registry,
    cfg: { login: RK.login, pass1: RK.pass1, pass2: RK.pass2, price: 990, periodDays: 30, trialDays: 14,
      platformBaseUrl: `https://${DOMAIN}`, ...extra },
  });
}

test('выключенный биллинг: магазины бесплатны, счета не выставляются', async t => {
  if (skipDb(t)) return;
  const off = createBilling({ db, registry, cfg: { login: '', pass1: '', pass2: '' } });
  assert.strictEqual(off.enabled, false);
  const shop = await makeShop('freebie', 'Бесплатный');
  const st = await off.statusForShop(shop);
  assert.strictEqual(st.state, 'free');
  assert.deepStrictEqual(await off.enforce(), [], 'выключенный биллинг никого не приостанавливает');
  await assert.rejects(() => off.createInvoice(shop), /не настроен/);
});

test('счёт и оплата: подпись, продление, дубликат уведомления', async t => {
  if (skipDb(t)) return;
  const b = makeBilling();
  const shop = await makeShop('payme', 'Платный');

  const st0 = await b.statusForShop(shop);
  assert.strictEqual(st0.state, 'trial', 'новый магазин в пробном периоде');

  const inv = await b.createInvoice(shop);
  assert.strictEqual(inv.invId, 1);
  assert.strictEqual(inv.amount, 990);
  const u = new URL(inv.url);
  assert.strictEqual(u.searchParams.get('InvId'), '1');
  assert.strictEqual(u.searchParams.get('SignatureValue').toLowerCase(), md5(`${RK.login}:990.00:1:${RK.pass1}`));
  assert.ok(u.searchParams.get('SuccessURL').includes('/api/platform/billing/success'));

  // Чужая подпись и чужая сумма не проходят
  let r = await b.handleResult({ OutSum: '990.00', InvId: '1', SignatureValue: 'deadbeef' });
  assert.strictEqual(r.status, 403);
  r = await b.handleResult({ OutSum: '1.00', InvId: '1', SignatureValue: md5(`1.00:1:${RK.pass2}`) });
  assert.strictEqual(r.status, 400);
  const [[invRow]] = await db.query('SELECT status FROM invoices WHERE inv_id = 1');
  assert.strictEqual(invRow.status, 'pending', 'счёт не зачтён без правильного уведомления');

  // Правильное уведомление: оплата зачтена, подписка на 30 дней
  r = await b.handleResult({ OutSum: '990.00', InvId: '1', SignatureValue: md5(`990.00:1:${RK.pass2}`) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.subdomain, 'payme');
  const [[sub]] = await db.query('SELECT paid_until FROM subscriptions WHERE shop_id = ?', [shop.shop_id]);
  assert.ok(sub.paid_until > new Date(Date.now() + 29 * 86400000), 'оплачено на ~30 дней вперёд');
  const st1 = await b.statusForShop(shop);
  assert.strictEqual(st1.state, 'active');

  // Повторное уведомление — идемпотентно
  r = await b.handleResult({ OutSum: '990.00', InvId: '1', SignatureValue: md5(`990.00:1:${RK.pass2}`) });
  assert.ok(r.ok && r.duplicate);

  // Оплата впрок: второй месяц добавляется к хвосту первого, а не к «сейчас»
  const before = sub.paid_until.getTime();
  const inv2 = await b.createInvoice(shop);
  assert.strictEqual(inv2.invId, 2);
  r = await b.handleResult({ OutSum: '990.00', InvId: '2', SignatureValue: md5(`990.00:2:${RK.pass2}`) });
  assert.strictEqual(r.ok, true);
  const [[sub2]] = await db.query('SELECT paid_until FROM subscriptions WHERE shop_id = ?', [shop.shop_id]);
  assert.ok(Math.abs(sub2.paid_until.getTime() - (before + 30 * 86400000)) < 60000, 'второй месяц лёг поверх первого');
});

test('enforce: просроченная подписка и пробный период приостанавливают', async t => {
  if (skipDb(t)) return;
  const b = makeBilling();

  const paid = await makeShop('overdue', 'Просрочен');
  // DATETIME-колонки живут в UTC (пул с timezone '+00:00'), поэтому и
  // «просрочку» пишем через UTC_TIMESTAMP, а не NOW().
  await db.query('INSERT INTO subscriptions (shop_id, plan, paid_until) VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 1 DAY)', [paid.shop_id, 'month']);
  const trial = await makeShop('oldtrial', 'Старый триал');
  await db.query('UPDATE shops SET created_at = NOW() - INTERVAL 30 DAY WHERE id = ?', [trial.shop_id]);

  const list = await b.enforce();
  const subs = list.map(x => x.subdomain);
  assert.ok(subs.includes('overdue'), 'просроченная подписка приостановлена');
  assert.ok(subs.includes('oldtrial'), 'просроченный пробный период приостановлен');
  assert.ok(!subs.includes('payme'), 'оплаченный магазин не задет');

  const [[row]] = await db.query('SELECT status FROM shops WHERE id = ?', [paid.shop_id]);
  assert.strictEqual(row.status, 'suspended');

  // Оплата возвращает магазин в active
  const inv = await b.createInvoice(paid);
  const r = await b.handleResult({ OutSum: '990.00', InvId: String(inv.invId), SignatureValue: md5(`990.00:${inv.invId}:${RK.pass2}`) });
  assert.strictEqual(r.ok, true);
  const [[row2]] = await db.query('SELECT status FROM shops WHERE id = ?', [paid.shop_id]);
  assert.strictEqual(row2.status, 'active');
});

// ---------- платформа целиком: биллинг через HTTP ----------
function httpReq({ method = 'GET', p = '/', host = '', body, headers = {}, redirect = 'manual' }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: p,
      headers: {
        ...headers,
        ...(host ? { host } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch (e) { /* не json */ }
        resolve({ status: res.statusCode, text, json: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('биллинг выключен у платформы без ROBOKASSA_*', async t => {
  if (skipHttp(t)) return;
  const reg = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Без биллинга', subdomain: 'nobill' },
  });
  assert.strictEqual(reg.status, 200, reg.text);
  const st = await httpReq({
    host: 'nobill.' + DOMAIN, p: '/api/admin/billing',
    headers: { 'x-admin-token': reg.json.adminToken },
  });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.json.enabled, false);
  assert.strictEqual(st.json.state, 'free', 'без кассы магазин бесплатен');
  const pay = await httpReq({
    method: 'POST', p: '/api/admin/billing/pay', host: 'nobill.' + DOMAIN,
    body: {}, headers: { 'x-admin-token': reg.json.adminToken },
  });
  assert.strictEqual(pay.status, 400, 'без кассы счёт не выставляется');
  // Витрина работает бесплатно
  const s = await httpReq({ host: 'nobill.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(s.status, 200);
});

test('полный цикл: оплата снимает приостановку после рестарта', async t => {
  if (skipHttp(t)) return;

  // Перезапуск с включённым биллингом поверх той же БД
  await new Promise(resolve => { child.on('exit', resolve); child.kill(); });
  child = spawnPlatform({
    ...platformEnv,
    ROBOKASSA_LOGIN: RK.login, ROBOKASSA_PASS1: RK.pass1, ROBOKASSA_PASS2: RK.pass2,
    ROBOKASSA_IS_TEST: '1', BILLING_PRICE: '990', BILLING_TRIAL_DAYS: '14',
  });
  await waitReady(child);

  const reg = await httpReq({
    method: 'POST', p: '/api/platform/register', host: DOMAIN,
    body: { shopName: 'Цикл', subdomain: 'cycle' },
  });
  assert.strictEqual(reg.status, 200, reg.text);
  const token = reg.json.adminToken;

  const st = await httpReq({ host: 'cycle.' + DOMAIN, p: '/api/admin/billing', headers: { 'x-admin-token': token } });
  assert.strictEqual(st.json.enabled, true);
  assert.strictEqual(st.json.state, 'trial');

  const pay = await httpReq({
    method: 'POST', p: '/api/admin/billing/pay', host: 'cycle.' + DOMAIN,
    body: {}, headers: { 'x-admin-token': token },
  });
  assert.strictEqual(pay.status, 200, pay.text);
  const invId = new URL(pay.json.url).searchParams.get('InvId');
  assert.ok(new URL(pay.json.url).searchParams.get('IsTest'), 'тестовый режим проброшен в кассу');

  // Result-уведомление — как его шлёт Robokassa
  const res1 = await httpReq({
    host: DOMAIN, p: `/api/platform/billing/result?OutSum=990.00&InvId=${invId}&SignatureValue=${md5(`990.00:${invId}:${RK.pass2}`)}`,
  });
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.text, `OK${invId}`);
  const st2 = await httpReq({ host: 'cycle.' + DOMAIN, p: '/api/admin/billing', headers: { 'x-admin-token': token } });
  assert.strictEqual(st2.json.state, 'active');

  // Success-редирект возвращает продавца в его админку
  const succ = await httpReq({
    host: DOMAIN, p: `/api/platform/billing/success?OutSum=990.00&InvId=${invId}&SignatureValue=${md5(`990.00:${invId}:${RK.pass1}`)}`,
  });
  assert.strictEqual(succ.status, 302);
  assert.strictEqual(succ.headers.location, `https://cycle.${DOMAIN}/admin.html?paid=1`);

  // Просрочка -> рестарт -> витрина закрыта, админка жива
  await db.query('UPDATE subscriptions SET paid_until = UTC_TIMESTAMP() - INTERVAL 1 HOUR ' +
    'WHERE shop_id = (SELECT id FROM shops WHERE subdomain = ?)', ['cycle']);
  await new Promise(resolve => { child.on('exit', resolve); child.kill(); });
  child = spawnPlatform({
    ...platformEnv,
    ROBOKASSA_LOGIN: RK.login, ROBOKASSA_PASS1: RK.pass1, ROBOKASSA_PASS2: RK.pass2,
    ROBOKASSA_IS_TEST: '1',
  });
  await waitReady(child);

  const closed = await httpReq({ host: 'cycle.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(closed.status, 402, 'витрина приостановленного магазина закрыта');
  const page = await httpReq({ host: 'cycle.' + DOMAIN, p: '/' });
  assert.strictEqual(page.status, 402);
  assert.ok(page.text.includes('приостановлен'), 'страница объясняет, что случилось');
  const adminOk = await httpReq({ host: 'cycle.' + DOMAIN, p: '/admin.html' });
  assert.strictEqual(adminOk.status, 200, 'админка доступна для оплаты');

  // Оплата прямо из приостановки возвращает магазин без рестарта
  const pay2 = await httpReq({
    method: 'POST', p: '/api/admin/billing/pay', host: 'cycle.' + DOMAIN,
    body: {}, headers: { 'x-admin-token': token },
  });
  assert.strictEqual(pay2.status, 200, pay2.text);
  const invId2 = new URL(pay2.json.url).searchParams.get('InvId');
  const res2 = await httpReq({
    host: DOMAIN, p: `/api/platform/billing/result?OutSum=990.00&InvId=${invId2}&SignatureValue=${md5(`990.00:${invId2}:${RK.pass2}`)}`,
  });
  assert.strictEqual(res2.text, `OK${invId2}`);
  const alive = await httpReq({ host: 'cycle.' + DOMAIN, p: '/api/settings' });
  assert.strictEqual(alive.status, 200, 'оплата сняла приостановку сразу');
});

// ---------- регрессии на исправленное ----------

test('счета не сталкиваются номерами при одновременном выставлении', async t => {
  if (skipDb(t)) return;
  const b = makeBilling();
  const shop = await makeShop('race', 'Гонка');

  // Раньше номер брался как SELECT MAX(inv_id)+1 отдельным запросом: обычный
  // SELECT в InnoDB ничего не блокирует, и одновременные нажатия «Оплатить»
  // получали один номер. Второму прилетала ошибка дубликата вместо ссылки.
  const invoices = await Promise.all(
    Array.from({ length: 8 }, () => b.createInvoice(shop))
  );

  const ids = invoices.map(i => i.invId);
  assert.strictEqual(new Set(ids).size, ids.length, `номера должны быть уникальны, получено: ${ids.join()}`);
  for (const id of ids) assert.ok(Number.isInteger(id) && id > 0, `битый номер ${id}`);
});

test('нулевой пробный период не приостанавливает только что созданный магазин', async t => {
  if (skipDb(t)) return;
  // BILLING_TRIAL_DAYS=0 — значение по умолчанию. До правки cutoff совпадал
  // с «сейчас», и enforce() гасил витрину магазина, созданного секунду назад.
  const b = makeBilling({ trialDays: 0 });
  const fresh = await makeShop('newborn', 'Только что');

  const list = await b.enforce();
  assert.ok(!list.some(x => x.subdomain === 'newborn'),
    'новый магазин не должен приостанавливаться в первый же день');

  // а вчерашний неоплаченный — должен
  const old = await makeShop('yesterday', 'Вчерашний');
  await db.query('UPDATE shops SET created_at = NOW() - INTERVAL 3 DAY WHERE id = ?', [old.shop_id]);
  const list2 = await b.enforce();
  assert.ok(list2.some(x => x.subdomain === 'yesterday'),
    'магазин старше суток без оплаты приостанавливается');
});

test('подпись Robokassa сравнивается без учёта регистра и не ломается на мусоре', () => {
  const rk = createRobokassa({ login: RK.login, pass1: RK.pass1, pass2: RK.pass2 });
  const sig = md5(`990.00:77:${RK.pass2}`);
  assert.ok(rk.verifyResult({ OutSum: '990.00', InvId: '77', SignatureValue: sig.toUpperCase() }));
  assert.ok(rk.verifyResult({ OutSum: '990.00', InvId: '77', SignatureValue: sig.toLowerCase() }));
  assert.ok(!rk.verifyResult({ OutSum: '990.00', InvId: '77', SignatureValue: 'подделка' }));
  // разной длины и пустые значения не должны бросать — только возвращать false
  assert.ok(!rk.verifyResult({ OutSum: '990.00', InvId: '77', SignatureValue: '' }));
  assert.ok(!rk.verifyResult({}));
});
