-- Признаки полноты профиля для предварительной сортировки кандидатов.
-- Раньше считались подзапросами на каждую строку: при 60 тыс. компаний в категории поиск занимал ~1,5 с.
-- Обновляются после импорта налоговых наборов и загрузки тестовой базы (refreshProfileFlags).

ALTER TABLE suppliers
  ADD COLUMN has_employees boolean NOT NULL DEFAULT false,
  ADD COLUMN has_revenue boolean NOT NULL DEFAULT false;

WITH f AS (
  SELECT s.id,
         COALESCE((SELECT v.value::numeric > 0 FROM verification_records v
                    WHERE v.supplier_id = s.id AND v.field = 'employees_count' AND v.value ~ '^[0-9]+$'
                    ORDER BY v.checked_at DESC LIMIT 1), false) AS e,
         COALESCE((SELECT fr.revenue > 0 FROM financial_reports fr
                    WHERE fr.supplier_id = s.id ORDER BY fr.period_year DESC LIMIT 1), false) AS r
    FROM suppliers s
)
UPDATE suppliers s SET has_employees = f.e, has_revenue = f.r
  FROM f WHERE f.id = s.id AND (f.e OR f.r);

CREATE INDEX product_records_category_supplier_idx ON product_records (category_id, supplier_id);
