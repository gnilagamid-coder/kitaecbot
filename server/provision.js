'use strict';
// Создание нового магазина «под ключ»: строки tenant/shop в реестре,
// одноразовый пароль админки (в БД уходит только sha256-хэш), папка данных
// со стартовыми настройками. Вызывается из регистрации на платформе
// и из импортёра legacy-магазинов.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS, sanitize, mergeDeep } = require('./settings');
const { validateSubdomain } = require('./registry');
const { encryptSecret } = require('./secrets');

const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function provisionShop({
  registry,
  dataRoot,            // корень папок магазинов платформы
  subdomain,
  shopName = '',
  email = '',
  botToken = '',       // необязателен: магазин может стартовать без бота
  secretKey = '',
}) {
  const v = validateSubdomain(subdomain);
  if (!v.ok) throw new Error(v.error);
  const sub = v.subdomain;

  if (await registry.findShopBySubdomain(sub)) {
    const e = new Error(`поддомен «${sub}» уже занят`);
    e.status = 409;
    throw e;
  }

  // Пароль админки показывается владельцу ровно один раз — в ответе регистрации.
  const adminToken = crypto.randomBytes(18).toString('base64url');
  const adminTokenHash = sha256hex(adminToken);

  const name = String(shopName || '').trim().slice(0, 190) || `Магазин ${sub}`;
  const tenantId = await registry.createTenant({
    slug: sub, // slug уникален; поддомен и берём — короче некуда
    name,
    email: String(email || '').trim().slice(0, 190),
    status: 'trial',
  });

  const botTokenEnc = botToken
    ? Buffer.from(encryptSecret(String(botToken).trim(), secretKey), 'utf8')
    : null;

  const shopId = await registry.createShop({
    tenantId,
    subdomain: sub,
    title: name,
    adminTokenHash,
    botTokenEnc,
    status: 'active',
  });

  // Папка данных: store сам создаст JSON-файлы при первой записи, но images/
  // нужен сразу — витрина и админка кладут туда картинки.
  const dataDir = path.join(dataRoot, sub);
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  // Дефолты целиком из settings.js (сейчас — Liquid Glass), сверху имя.
  const settings = sanitize(mergeDeep(DEFAULTS, { brand: { shopName: name } }));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  return { tenantId, shopId, subdomain: sub, shopName: name, adminToken, dataDir };
}

module.exports = { provisionShop };
