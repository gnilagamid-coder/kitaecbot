'use strict';
// Импортёр файловых магазинов на платформу.
//
// Переезд без потерь в два слоя:
//   1) MySQL — товары/заказы/картинки/настройки/просмотры укладываются в схему
//      0001_core.sql: legacy_id связывает старые id с новыми, заказы и товары
//      целиком дублируются в raw-колонки (переживают поля, которых схема не знает);
//   2) рабочая папка магазина в MULTITENANT_DATA_ROOT — в Stage 3 витрина ещё
//      живёт на файлах, поэтому магазин должен стартовать сразу после импорта.
//
// Использование:
//   node server/import-shop.js <папка данных> <поддомен>
// Нужны MYSQL_* и SECRET_KEY в .env; MULTITENANT_DATA_ROOT — куда кладём магазин.

require('./env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { createDb, dbConfigFromEnv } = require('./db');
const { createMigrator } = require('./migrations');
const { createRegistry } = require('./registry');
const { provisionShop } = require('./provision');
const { sanitize } = require('./settings');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
const ORDER_STATUSES = new Set(['new', 'processing', 'shipped', 'done', 'cancelled']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

async function importLegacy({ db, registry, dataDir, subdomain, dataRoot, secretKey = '', botToken = '', email = '' }) {
  const legacySettings = readJson(path.join(dataDir, 'settings.json'), {});
  const products = readJson(path.join(dataDir, 'products.json'), []);
  const orders = readJson(path.join(dataDir, 'orders.json'), []);
  const views = readJson(path.join(dataDir, 'views.json'), {});

  const shopName = (legacySettings.brand && legacySettings.brand.shopName)
    || path.basename(path.resolve(dataDir));

  // Строки реестра + рабочая папка со стартовыми настройками.
  const p = await provisionShop({ registry, dataRoot, subdomain, shopName, email, botToken, secretKey });
  const shopId = p.shopId;

  // ---- рабочая папка: переносим как есть, магазин стартует сразу ----
  fs.writeFileSync(path.join(p.dataDir, 'settings.json'),
    JSON.stringify(sanitize(legacySettings), null, 2), 'utf8');
  fs.writeFileSync(path.join(p.dataDir, 'products.json'), JSON.stringify(products, null, 2), 'utf8');
  fs.writeFileSync(path.join(p.dataDir, 'orders.json'), JSON.stringify(orders, null, 2), 'utf8');
  if (Object.keys(views).length) {
    fs.writeFileSync(path.join(p.dataDir, 'views.json'), JSON.stringify(views, null, 2), 'utf8');
  }
  const imgSrc = path.join(dataDir, 'images');
  let imagesCopied = 0;
  if (fs.existsSync(imgSrc)) {
    for (const f of fs.readdirSync(imgSrc)) {
      fs.copyFileSync(path.join(imgSrc, f), path.join(p.dataDir, 'images', f));
      imagesCopied++;
    }
  }

  // ---- MySQL: копия данных для Stage 4 и как сейф «ничего не потерять» ----
  const legacyToNew = new Map(); // старый id товара -> новый id в БД

  await db.tx(async conn => {
    await conn.query('INSERT INTO shop_settings (shop_id, settings) VALUES (?, ?)',
      [shopId, JSON.stringify(sanitize(legacySettings))]);

    // Товары
    let sort = 0;
    for (const pr of products) {
      const [r] = await conn.query(
        `INSERT INTO products
           (shop_id, legacy_id, name, description, category, price, old_price, stock, badge, featured, hidden, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [shopId, String(pr.id), String(pr.name || '').slice(0, 190),
          String(pr.description || '').slice(0, 1000), String(pr.category || '').slice(0, 40),
          Number(pr.price) || 0,
          pr.oldPrice == null || pr.oldPrice === '' ? null : Number(pr.oldPrice),
          pr.stock == null || pr.stock === '' ? null : Number(pr.stock),
          String(pr.badge || '').slice(0, 16), pr.featured ? 1 : 0, pr.hidden ? 1 : 0, sort++]);
      legacyToNew.set(String(pr.id), r.insertId);

      // Порядок картинок важен: первая — обложка.
      let pos = 0;
      for (const file of (pr.images || [])) {
        await conn.query(
          'INSERT INTO product_images (product_id, shop_id, filename, kind, position) VALUES (?, ?, ?, ?, ?)',
          [r.insertId, shopId, String(file), 'full', pos++]);
      }
      pos = 0;
      for (const file of (pr.thumbs || [])) {
        await conn.query(
          'INSERT INTO product_images (product_id, shop_id, filename, kind, position) VALUES (?, ?, ?, ?, ?)',
          [r.insertId, shopId, String(file), 'thumb', pos++]);
      }
    }

    // Картинки — байтами.
    if (fs.existsSync(imgSrc)) {
      for (const f of fs.readdirSync(imgSrc)) {
        const ext = path.extname(f).toLowerCase();
        await conn.query(
          'INSERT INTO images (shop_id, filename, content_type, bytes) VALUES (?, ?, ?, ?)',
          [shopId, f, MIME_BY_EXT[ext] || 'image/jpeg', fs.readFileSync(path.join(imgSrc, f))]);
      }
    }

    // Заказы: id оставляем прежним (Date.now), весь объект — в raw.
    for (const o of orders) {
      const status = ORDER_STATUSES.has(o.status) ? o.status : 'new';
      await conn.query(
        `INSERT INTO orders
           (shop_id, id, at, status, paid, subtotal, total, promo, customer, tg_user, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [shopId, Number(o.id), o.at ? new Date(o.at) : new Date(), status, o.paid ? 1 : 0,
          Number(o.subtotal) || 0, Number(o.total) || 0,
          o.promo ? JSON.stringify(o.promo) : null,
          o.customer ? JSON.stringify(o.customer) : null,
          o.user ? JSON.stringify(o.user) : null,
          JSON.stringify(o)]);

      let posIdx = 0;
      for (const it of (o.items || [])) {
        await conn.query(
          `INSERT INTO order_items (shop_id, order_id, pos, product_id, name, price, qty)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [shopId, Number(o.id), posIdx++, legacyToNew.get(String(it.id)) || null,
            String(it.name || '').slice(0, 190), Number(it.price) || 0, Number(it.qty) || 1]);
      }
    }

    // Просмотры: ключ исторически строковый.
    for (const [key, n] of Object.entries(views)) {
      await conn.query(
        'INSERT INTO product_views (shop_id, product_key, views) VALUES (?, ?, ?)',
        [shopId, String(key).slice(0, 64), Number(n) || 0]);
    }
  });

  return {
    subdomain: p.subdomain, shopId, shopName: p.shopName,
    adminToken: p.adminToken, dataDir: p.dataDir,
    products: products.length, orders: orders.length, images: imagesCopied,
  };
}

// ---------- CLI ----------
async function main() {
  const [dataDir, subdomain] = process.argv.slice(2);
  if (!dataDir || !subdomain) {
    console.error('Использование: node server/import-shop.js <папка данных> <поддомен>');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dataDir, 'products.json'))) {
    console.error(`В ${dataDir} нет products.json — это не папка данных магазина`);
    process.exit(1);
  }
  const cfg = dbConfigFromEnv();
  if (!cfg.host || !cfg.database) { console.error('Не настроены MYSQL_HOST/MYSQL_DATABASE'); process.exit(1); }
  const secretKey = process.env.SECRET_KEY || '';
  if (secretKey.length < 12) { console.error('SECRET_KEY обязателен (от 12 символов)'); process.exit(1); }
  const dataRoot = process.env.MULTITENANT_DATA_ROOT || path.join(process.cwd(), 'data', 'shops');

  const db = createDb(cfg);
  try {
    await createMigrator({ db }).up();
    const registry = createRegistry(db);
    const r = await importLegacy({
      db, registry, dataDir, subdomain, dataRoot, secretKey,
      botToken: process.env.BOT_TOKEN || '',
      email: process.env.IMPORT_EMAIL || '',
    });
    const domain = process.env.MULTITENANT_DOMAIN || '';
    console.log('Импорт завершён:');
    console.log(`  магазин:    ${r.shopName} (${r.subdomain}${domain ? ' → https://' + r.subdomain + '.' + domain : ''})`);
    console.log(`  товары:     ${r.products}, заказы: ${r.orders}, картинки: ${r.images}`);
    console.log(`  папка:      ${r.dataDir}`);
    console.log(`  пароль админки (показываем один раз): ${r.adminToken}`);
  } finally {
    await db.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Импорт не удался:', e.message); process.exit(1); });
}

module.exports = { importLegacy };
