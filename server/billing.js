'use strict';
// Биллинг платформы: подписка магазина (продавца) на сервис через Robokassa.
//
// ВАЖНО: это не приём денег от покупателей — оплата заказов живёт в
// payments.js и настройках каждого магазина и от биллинга не зависит.
//
// Биллинг опционален: без ROBOKASSA_LOGIN/паролей enabled=false, магазины
// работают бесплатно вечно, enforce() никого не трогает.
//
// Жизненный цикл: регистрация -> trial (BILLING_TRIAL_DAYS от created_at)
// -> оплата счета продлевает подписку на BILLING_PERIOD_DAYS -> просрочка
// переводит магазин в suspended (витрина отдаёт 402, админка и оплата
// продолжают работать, чтобы продавец мог продлить).

const { createRobokassa } = require('./robokassa');

const DAY_MS = 24 * 60 * 60 * 1000;

function createBilling({ db, registry, cfg }) {
  const enabled = Boolean(cfg.login && cfg.pass1 && cfg.pass2);
  const price = Number(cfg.price) || 0;
  const periodDays = Number(cfg.periodDays) || 30;
  const trialDays = Number(cfg.trialDays) || 0;
  const platformBaseUrl = String(cfg.platformBaseUrl || '').replace(/\/$/, '');
  const rk = enabled
    ? createRobokassa({ login: cfg.login, pass1: cfg.pass1, pass2: cfg.pass2, isTest: Boolean(cfg.isTest) })
    : null;

  async function getPaidUntil(shopId, conn) {
    const q = conn || db;
    const [rows] = await q.query('SELECT paid_until FROM subscriptions WHERE shop_id = ?', [shopId]);
    return rows.length ? rows[0].paid_until : null;
  }

  // Полная картина подписки для админки магазина.
  async function statusForShop(shopRow) {
    const now = new Date();
    const paidUntil = (await getPaidUntil(shopRow.shop_id)) || null;
    const trialUntil = new Date(new Date(shopRow.created_at).getTime() + trialDays * DAY_MS);
    let state;
    if (!enabled) state = 'free';
    else if (paidUntil && paidUntil > now) state = 'active';
    else if (trialDays > 0 && trialUntil > now) state = 'trial';
    else state = 'overdue';
    return { enabled, plan: 'month', price, state, paidUntil, trialUntil, periodDays, trialDays };
  }

  // Новый счёт: InvId — следующий номер в таблице, счёт всегда pending,
  // пока Result-уведомление не подтвердит оплату.
  async function createInvoice(shopRow) {
    if (!enabled) {
      const e = new Error('биллинг не настроен'); e.status = 400; throw e;
    }
    const amount = price;
    let invId, url;
    await db.tx(async conn => {
      const [[m]] = await conn.query('SELECT COALESCE(MAX(inv_id), 0) AS n FROM invoices');
      invId = Number(m.n) + 1;
      await conn.query(
        'INSERT INTO invoices (shop_id, inv_id, plan, amount) VALUES (?, ?, ?, ?)',
        [shopRow.shop_id, invId, 'month', amount]);
    });
    const title = shopRow.title || shopRow.subdomain;
    url = rk.payUrl({
      amount, invId,
      description: `Подписка на платформу: «${title}»`,
      successUrl: `${platformBaseUrl}/api/platform/billing/success`,
      failUrl: `${platformBaseUrl}/api/platform/billing/fail`,
    });
    return { invId, amount, url };
  }

  // Result-уведомление Robokassa. Отвечаем «OK<InvId>» только при полной
  // проверке — иначе платёжка будет слать уведомление повторно, и это
  // правильно: лучше продублировать проверку, чем зачесть чужую оплату.
  async function handleResult(params) {
    if (!enabled) return { ok: false, status: 404, error: 'биллинг не настроен' };
    if (!rk.verifyResult(params)) return { ok: false, status: 403, error: 'подпись не сходится' };
    const invId = Number(params.InvId);
    const [rows] = await db.query(
      'SELECT i.id, i.shop_id, i.amount, i.status, s.subdomain ' +
      'FROM invoices i JOIN shops s ON s.id = i.shop_id WHERE i.inv_id = ?', [invId]);
    if (!rows.length) return { ok: false, status: 404, error: 'счёт не найден' };
    const inv = rows[0];
    if (inv.status === 'paid') return { ok: true, invId, shopId: inv.shop_id, subdomain: inv.subdomain, duplicate: true };
    if (Math.abs(Number(params.OutSum) - Number(inv.amount)) > 0.009) {
      return { ok: false, status: 400, error: 'сумма не сходится' };
    }

    const now = new Date();
    let paidUntil;
    await db.tx(async conn => {
      await conn.query("UPDATE invoices SET status = 'paid', paid_at = NOW(3) WHERE id = ?", [inv.id]);
      const cur = await getPaidUntil(inv.shop_id, conn);
      // Продление идёт от хвоста текущей оплаты, а не от «сейчас»:
      // оплатил месяц впрок — второй месяц не сгорает.
      const base = cur && cur > now ? cur : now;
      paidUntil = new Date(base.getTime() + periodDays * DAY_MS);
      await conn.query(
        'INSERT INTO subscriptions (shop_id, plan, paid_until) VALUES (?, ?, ?) ' +
        'AS new ON DUPLICATE KEY UPDATE paid_until = new.paid_until, plan = new.plan',
        [inv.shop_id, 'month', paidUntil]);
      // Оплата снимает приостановку.
      await conn.query("UPDATE shops SET status = 'active' WHERE id = ? AND status = 'suspended'", [inv.shop_id]);
    });
    return { ok: true, invId, shopId: inv.shop_id, subdomain: inv.subdomain, paidUntil };
  }

  // Редиректы покупателя после кассы: куда вернуть продавца. Подпись та же
  // схема, что у Result, но на Password1.
  async function redirectFor(params) {
    if (!enabled || !rk.verifySuccess(params)) return null;
    const [rows] = await db.query(
      'SELECT s.subdomain FROM invoices i JOIN shops s ON s.id = i.shop_id WHERE i.inv_id = ?',
      [Number(params.InvId)]);
    return rows.length ? rows[0].subdomain : null;
  }

  // Просроченные активные магазины -> suspended. Вызывается при старте и по
  // таймеру. Если биллинг выключен — никто никогда не приостанавливается.
  async function enforce(now = new Date()) {
    if (!enabled) return [];
    const trialCutoff = new Date(now.getTime() - trialDays * DAY_MS);
    const [rows] = await db.query(
      `SELECT s.id AS shop_id, s.subdomain, sub.paid_until, s.created_at
         FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id
        WHERE s.status = 'active'
          AND ( (sub.paid_until IS NOT NULL AND sub.paid_until < ?)
             OR (sub.paid_until IS NULL AND s.created_at < ?) )`,
      [now, trialCutoff]);
    for (const r of rows) await registry.setShopStatus(r.shop_id, 'suspended');
    return rows.map(r => ({ shopId: r.shop_id, subdomain: r.subdomain }));
  }

  return { enabled, price, periodDays, trialDays, statusForShop, createInvoice, handleResult, redirectFor, enforce };
}

module.exports = { createBilling };
