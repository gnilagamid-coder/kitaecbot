-- 0001_core.sql — ядро схемы SaaS-платформы.
-- Арендатор (tenant) → магазин (shop) → данные магазина. Все таблицы
-- магазина имеют shop_id и каскадно удаляются вместе с магазином.
-- utf8mb4 — кириллица и эмодзи в названиях/именах покупателей.

CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(64) NOT NULL COMMENT 'короткий идентификатор для URL/счетов',
  name VARCHAR(190) NOT NULL DEFAULT '' COMMENT 'название компании/ИП',
  email VARCHAR(190) NOT NULL DEFAULT '',
  phone VARCHAR(32) NOT NULL DEFAULT '',
  status ENUM('trial','active','suspended','deleted') NOT NULL DEFAULT 'trial',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  subdomain VARCHAR(63) NOT NULL COMMENT 'shop1.example.ru -> shop1',
  title VARCHAR(190) NOT NULL DEFAULT '',
  bot_token_enc VARBINARY(512) NULL COMMENT 'токен бота в зашифрованном виде (Stage 3)',
  admin_token_hash CHAR(64) NOT NULL DEFAULT '' COMMENT 'sha256(ADMIN_TOKEN)',
  admin_chat_ids JSON NULL COMMENT 'chat_id владельцев, кому открыта админка',
  status ENUM('provisioning','active','suspended','deleted') NOT NULL DEFAULT 'provisioning',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_shops_subdomain (subdomain),
  KEY ix_shops_tenant (tenant_id),
  CONSTRAINT fk_shops_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Настройки магазина — тот же settings.json, что и в файловом магазине,
-- целиком в JSON-колонке: структура уже проверена sanitize() в settings.js.
CREATE TABLE IF NOT EXISTS shop_settings (
  shop_id BIGINT UNSIGNED NOT NULL,
  settings JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (shop_id),
  CONSTRAINT fk_settings_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Товары. legacy_id — прежний числовой id из products.json: при переезде
-- живых магазинов заказы и картинки ссылаются на старые id, терять их нельзя.
CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id BIGINT UNSIGNED NOT NULL,
  legacy_id VARCHAR(32) NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  category VARCHAR(40) NOT NULL DEFAULT '',
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  old_price DECIMAL(12,2) NULL,
  stock INT NULL COMMENT 'NULL = остаток не отслеживается',
  badge VARCHAR(16) NOT NULL DEFAULT '',
  featured TINYINT(1) NOT NULL DEFAULT 0,
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_shop_legacy (shop_id, legacy_id),
  KEY ix_products_shop (shop_id, hidden),
  CONSTRAINT fk_products_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Связь товара с картинками: порядок важен (первая — обложка),
-- отдельный вид thumb/full повторяет пары images[]/thumbs[] из JSON.
CREATE TABLE IF NOT EXISTS product_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  filename VARCHAR(128) NOT NULL COMMENT 'img_xxx.png из таблицы images',
  kind ENUM('full','thumb') NOT NULL DEFAULT 'full',
  position TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_pimg_product (product_id, kind, position),
  KEY ix_pimg_shop_file (shop_id, filename),
  CONSTRAINT fk_pimg_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Картинки: байты в БД, чтобы магазин переезжал между нодами без rsync.
-- 6 МБ на файл хватает с запасом (лимит загрузки в index.js — 8 МБ на тело).
CREATE TABLE IF NOT EXISTS images (
  shop_id BIGINT UNSIGNED NOT NULL,
  filename VARCHAR(128) NOT NULL,
  content_type VARCHAR(64) NOT NULL DEFAULT 'image/jpeg',
  bytes LONGBLOB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (shop_id, filename),
  CONSTRAINT fk_images_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Заказы. id оставляем BIGINT от Date.now(), как в файловой версии, —
-- ключ (shop_id, id): свои последовательности у каждого магазина.
-- raw — исходный объект заказа целиком: перенос из orders.json обязан пройти
-- без потерь даже для полей, о которых схема ещё не знает.
CREATE TABLE IF NOT EXISTS orders (
  shop_id BIGINT UNSIGNED NOT NULL,
  id BIGINT NOT NULL,
  at DATETIME(3) NOT NULL,
  status ENUM('new','processing','shipped','done','cancelled') NOT NULL DEFAULT 'new',
  status_at DATETIME(3) NULL,
  paid TINYINT(1) NOT NULL DEFAULT 0,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  promo JSON NULL COMMENT '{code, discount, label}',
  customer JSON NULL,
  tg_user JSON NULL COMMENT '{id, username, name}',
  raw JSON NOT NULL COMMENT 'исходный объект заказа (перенос без потерь)',
  PRIMARY KEY (shop_id, id),
  KEY ix_orders_shop_status (shop_id, status),
  KEY ix_orders_shop_at (shop_id, at),
  CONSTRAINT fk_orders_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Позиции заказа — срез цен/названий на момент покупки.
CREATE TABLE IF NOT EXISTS order_items (
  shop_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT NOT NULL,
  pos INT UNSIGNED NOT NULL DEFAULT 0,
  product_id BIGINT NULL COMMENT 'NULL, если товар уже удалён',
  name VARCHAR(190) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  qty INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, order_id, pos),
  CONSTRAINT fk_items_order FOREIGN KEY (shop_id, order_id)
    REFERENCES orders (shop_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Просмотры товаров: key строкой, потому что исторически счётчик
-- ставился по строковому id товара из views.json.
CREATE TABLE IF NOT EXISTS product_views (
  shop_id BIGINT UNSIGNED NOT NULL,
  product_key VARCHAR(64) NOT NULL,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, product_key),
  CONSTRAINT fk_views_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
