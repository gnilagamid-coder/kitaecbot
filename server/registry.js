'use strict';
// Реестр арендаторов: CRUD поверх tenants/shops из миграции 0001_core.sql.
// Реестр — единственное место, где платформа узнаёт, какой магазин живёт
// на каком поддомене и чем он дышит (токен бота, хэш пароля админки,
// список владельцев). Роутинг в index.js читает отсюда.

// Поддомен: латиница/цифры/дефис, 2..32 символа, не начинается и не
// кончается дефисом. Служебные имена резервируем под платформу.
const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'bot', 'mail', 'cdn', 'shop', 'shops',
  'platform', 'static', 'smtp', 'ftp', 'ns1', 'ns2', 'mx',
]);

function validateSubdomain(raw) {
  const sub = String(raw || '').trim().toLowerCase();
  if (!sub) return { ok: false, error: 'поддомен не задан' };
  if (sub.length < 2) return { ok: false, error: 'поддомен короче 2 символов' };
  if (!SUB_RE.test(sub)) {
    return { ok: false, error: 'поддомен: только латиница, цифры и дефис; не может начинаться/кончаться дефисом' };
  }
  if (RESERVED.has(sub)) return { ok: false, error: `поддомен «${sub}» зарезервирован платформой` };
  return { ok: true, subdomain: sub };
}

function createRegistry(db) {
  // Возвращает insertId новой строки.
  async function createTenant({ slug, name = '', email = '', phone = '', status = 'trial' }) {
    const [r] = await db.query(
      'INSERT INTO tenants (slug, name, email, phone, status) VALUES (?, ?, ?, ?, ?)',
      [slug, name, email, phone, status]);
    return r.insertId;
  }

  async function createShop({
    tenantId, subdomain, title = '', adminTokenHash,
    botTokenEnc = null, adminChatIds = null, status = 'active',
  }) {
    const [r] = await db.query(
      `INSERT INTO shops (tenant_id, subdomain, title, bot_token_enc, admin_token_hash, admin_chat_ids, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, subdomain, title, botTokenEnc, String(adminTokenHash),
        adminChatIds ? JSON.stringify(adminChatIds) : null, status]);
    return r.insertId;
  }

  // Строка магазина вместе с арендатором. status не фильтруем: вызывающий
  // сам решает, обслуживать ли provisioning/suspended (см. resolveTenantByHost).
  async function findShopBySubdomain(subdomain) {
    const [rows] = await db.query(
      `SELECT s.id AS shop_id, s.subdomain, s.title, s.bot_token_enc, s.admin_token_hash,
              s.admin_chat_ids, s.status, s.tenant_id,
              t.slug AS tenant_slug, t.name AS tenant_name, t.email AS tenant_email
         FROM shops s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.subdomain = ?`,
      [String(subdomain).toLowerCase()]);
    return rows[0] || null;
  }

  async function listActiveShops() {
    const [rows] = await db.query(
      `SELECT s.id AS shop_id, s.subdomain, s.title, s.status
         FROM shops s
        WHERE s.status IN ('active', 'provisioning')
        ORDER BY s.id`);
    return rows;
  }

  async function setShopStatus(shopId, status) {
    await db.query('UPDATE shops SET status = ? WHERE id = ?', [status, shopId]);
  }

  async function setBotToken(shopId, encBuf) {
    await db.query('UPDATE shops SET bot_token_enc = ? WHERE id = ?', [encBuf, shopId]);
  }

  async function countShops() {
    const [[r]] = await db.query('SELECT COUNT(*) AS n FROM shops');
    return Number(r.n);
  }

  return {
    db,
    validateSubdomain,
    createTenant, createShop,
    findShopBySubdomain, listActiveShops,
    setShopStatus, setBotToken, countShops,
  };
}

module.exports = { createRegistry, validateSubdomain, RESERVED };
