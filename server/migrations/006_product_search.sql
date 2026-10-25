-- Поиск на уровне товара: «фанера 18 мм» должна находить производителей фанеры, а не всю категорию «Пиломатериалы».

-- Названия продукции в декларациях и сертификатах (русская морфология: «фанеры», «фанерой» → «фанер»)
ALTER TABLE compliance_documents
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(product_name, ''))) STORED;
CREATE INDEX compliance_documents_search_idx ON compliance_documents USING gin (search_tsv);
CREATE INDEX compliance_documents_product_idx ON compliance_documents (product_id, supplier_id) WHERE product_id IS NOT NULL;

-- Что компания делает: основной ОКВЭД и заявленная продукция (вес A), дополнительные ОКВЭД (вес C)
ALTER TABLE suppliers ADD COLUMN search_tsv tsvector;

CREATE FUNCTION suppliers_search_tsv() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  declared text := (SELECT string_agg(d->>'name', ' ') FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(NEW.declared_products) = 'array' THEN NEW.declared_products ELSE '[]'::jsonb END) d);
  additional text := (SELECT string_agg(o->>'name', ' ') FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(NEW.okved_additional) = 'array' THEN NEW.okved_additional ELSE '[]'::jsonb END) o);
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('russian', coalesce(NEW.okved_main->>'name', '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(declared, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(additional, '')), 'C');
  RETURN NEW;
END $$;

CREATE TRIGGER suppliers_search_tsv
  BEFORE INSERT OR UPDATE OF okved_main, okved_additional, declared_products ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_search_tsv();

UPDATE suppliers SET okved_main = okved_main;
CREATE INDEX suppliers_search_idx ON suppliers USING gin (search_tsv);

-- Товар по ОКВЭД или заявленной продукции: отбор кандидатов по конкретному товару
CREATE INDEX product_records_product_supplier_idx ON product_records (product_id, supplier_id) WHERE product_id IS NOT NULL;
