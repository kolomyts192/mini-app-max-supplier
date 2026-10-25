-- Карантин импорта открытых данных: записи, которые не прошли проверку реквизитов или не разобрались.
-- Импорт не останавливается, а сохраняет причину и исходный фрагмент для разбора.
CREATE TABLE opendata_quarantine (
  id         bigserial PRIMARY KEY,
  dataset    text NOT NULL,
  reason     text NOT NULL,
  inn        text,
  payload    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opendata_quarantine_dataset_idx ON opendata_quarantine (dataset, reason);

-- Повторный импорт набора заменяет его сведения целиком: удаление по полю и источнику
CREATE INDEX verification_records_field_source_idx ON verification_records (field, source);
