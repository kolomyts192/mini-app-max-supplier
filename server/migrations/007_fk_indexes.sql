-- Индекс под внешний ключ compliance_documents.product_record_id → product_records (ON DELETE SET NULL).
-- Без него каждая удалённая при импорте запись о продукции просматривает все документы Росаккредитации:
-- повторный импорт реестра МСП при загруженных документах замедлялся в десятки раз.
CREATE INDEX IF NOT EXISTS compliance_documents_product_record_idx ON compliance_documents (product_record_id) WHERE product_record_id IS NOT NULL;
