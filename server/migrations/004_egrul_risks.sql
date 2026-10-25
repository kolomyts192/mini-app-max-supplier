-- Риск-сигнал «ликвидация» из ЕГРЮЛ (решение о ликвидации внесено, но деятельность ещё не прекращена).
ALTER TABLE risk_signals DROP CONSTRAINT risk_signals_kind_check;
ALTER TABLE risk_signals ADD CONSTRAINT risk_signals_kind_check
  CHECK (kind IN ('RNP', 'BANKRUPTCY', 'BANKRUPTCY_INTENT', 'UNRELIABLE_INFO', 'LIQUIDATION'));

-- Поиск сведений ЕГРЮЛ по компании и дате проверки
CREATE INDEX verification_records_egrul_idx ON verification_records (supplier_id, checked_at) WHERE source = 'FNS_EGRUL';
