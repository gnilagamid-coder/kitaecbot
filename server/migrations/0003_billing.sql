-- 0003_billing.sql — подписка магазинов на платформу (Stage 5).
-- Биллинг опционален: без ROBOKASSA_LOGIN таблицы просто пустуют, а магазины
-- работают бесплатно. Это НЕ оплата покупателей — приём денег за заказы живёт
-- в payments.js и настройках магазина, здесь только подписка продавца.

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id BIGINT UNSIGNED NOT NULL,
  inv_id BIGINT UNSIGNED NOT NULL COMMENT 'номер счёта, он же InvId в Robokassa',
  plan VARCHAR(32) NOT NULL DEFAULT 'month',
  amount DECIMAL(10,2) NOT NULL COMMENT 'рубли',
  status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at TIMESTAMP(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_inv (inv_id),
  KEY ix_invoices_shop (shop_id),
  CONSTRAINT fk_invoices_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscriptions (
  shop_id BIGINT UNSIGNED NOT NULL,
  plan VARCHAR(32) NOT NULL DEFAULT 'month',
  paid_until DATETIME NULL COMMENT 'оплачено до; NULL — ещё ни разу не платили',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (shop_id),
  CONSTRAINT fk_subs_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
