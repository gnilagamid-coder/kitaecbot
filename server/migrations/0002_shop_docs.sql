-- 0002_shop_docs.sql — живые данные магазина в MySQL (Stage 4).
-- Каждый документ файлового стора (settings, products, orders, views, users…)
-- становится строкой: тот же JSON, та же семантика read/write, но магазин
-- переезжает между нодами без папки данных. Нормализованные таблицы из
-- 0001_core остаются структурированной копией для аналитики и биллинга.

CREATE TABLE IF NOT EXISTS shop_docs (
  shop_id BIGINT UNSIGNED NOT NULL,
  doc VARCHAR(64) NOT NULL COMMENT 'имя документа: settings, products, orders, ...',
  data JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (shop_id, doc),
  CONSTRAINT fk_docs_shop FOREIGN KEY (shop_id)
    REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
