-- Запросы коммерческих предложений (КП): что запросили, у кого и ответили ли поставщики.
-- Ответы на вопрос бота «Поставщики ответили?» — метрика пилота «дошли до контакта».
CREATE TABLE IF NOT EXISTS quote_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  search_id     text,
  query         jsonb NOT NULL,
  supplier_ids  uuid[] NOT NULL,
  source        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  followup_at   timestamptz NOT NULL,
  followup_sent_at timestamptz,
  answer        text CHECK (answer IN ('yes', 'no')),
  answered_at   timestamptz
);
CREATE INDEX IF NOT EXISTS quote_requests_due_idx ON quote_requests (followup_at) WHERE followup_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS quote_requests_user_idx ON quote_requests (user_id, created_at DESC);
