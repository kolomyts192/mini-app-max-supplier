import type { PoolClient } from 'pg';
import type { Db } from '../infra/db';
import type { SupplierRow } from './model';

const SELECT = `
  SELECT s.id, s.inn, s.ogrn, s.kpp, s.name, s.entity_type, s.legal_status, s.registration_date, s.region_code, s.region_name,
         s.city, s.address, s.okved_main, s.okved_additional, s.director, s.sme_status, s.supplier_type,
         s.supplier_type_confidence::float AS supplier_type_confidence, s.supplier_type_basis, s.website, s.phone, s.email,
         s.source_type, s.is_manual_test_data, s.checked_at,
         (SELECT v.value FROM verification_records v WHERE v.supplier_id = s.id AND v.field = 'employees_count' ORDER BY v.checked_at DESC LIMIT 1) AS employees,
         (SELECT f.revenue FROM financial_reports f WHERE f.supplier_id = s.id ORDER BY f.period_year DESC LIMIT 1) AS last_revenue,
         COALESCE((SELECT json_agg(json_build_object('product_id', p.product_id, 'category_id', p.category_id, 'title', p.title, 'origin', p.origin,
                                                     'characteristics', p.characteristics) ORDER BY p.title)
                     FROM product_records p WHERE p.supplier_id = s.id), '[]'::json) AS products
    FROM suppliers s`;

function map(r: Record<string, unknown>): SupplierRow {
  return {
    ...(r as unknown as SupplierRow),
    checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : (r.checked_at as string),
    employees: r.employees === null || r.employees === undefined ? null : Number(r.employees),
    last_revenue: r.last_revenue === null || r.last_revenue === undefined ? null : Number(r.last_revenue),
  };
}

/** Дедупликация по ИНН и ОГРН (одна компания — одна запись в выдаче). Компании без ОГРН сравниваются только по ИНН. */
export function dedupeSuppliers(rows: SupplierRow[]): SupplierRow[] {
  const seenInn = new Set<string>();
  const seenOgrn = new Set<string>();
  const out: SupplierRow[] = [];
  for (const r of rows) {
    if (seenInn.has(r.inn) || (r.ogrn && seenOgrn.has(r.ogrn))) continue;
    seenInn.add(r.inn);
    if (r.ogrn) seenOgrn.add(r.ogrn);
    out.push(r);
  }
  return out;
}

/**
 * Пересчитывает признаки полноты профиля (численность, выручка), по которым сортируются кандидаты.
 * Вызывается после импорта налоговых наборов и загрузки тестовой базы; меняет только отличающиеся строки.
 */
export async function refreshProfileFlags(db: Db | PoolClient, opts: { onlyTestData?: boolean } = {}): Promise<number> {
  const { rowCount } = await db.query(
    `WITH f AS (
       SELECT s.id,
              COALESCE((SELECT v.value::numeric > 0 FROM verification_records v
                         WHERE v.supplier_id = s.id AND v.field = 'employees_count' AND v.value ~ '^[0-9]+$'
                         ORDER BY v.checked_at DESC LIMIT 1), false) AS e,
              COALESCE((SELECT fr.revenue > 0 FROM financial_reports fr
                         WHERE fr.supplier_id = s.id ORDER BY fr.period_year DESC LIMIT 1), false) AS r
         FROM suppliers s
        WHERE NOT $1 OR s.is_manual_test_data
     )
     UPDATE suppliers s SET has_employees = f.e, has_revenue = f.r
       FROM f WHERE f.id = s.id AND (s.has_employees, s.has_revenue) IS DISTINCT FROM (f.e, f.r)`,
    [opts.onlyTestData ?? false],
  );
  return rowCount ?? 0;
}

export type DataMode = 'real' | 'test' | 'all';

export interface CandidateOptions {
  categoryId: string;
  productId: string | null;
  dataMode: DataMode;
  regionCode: string | null;
  strictRegion: boolean;
  neighbors: string[];
  manufacturerOnly: boolean;
  /** Слова товара для полнотекстового поиска по документам и видам деятельности. */
  terms?: string[];
  limit?: number;
}

/**
 * Кандидаты по товару. В выборку входят компании категории и компании с ОКВЭД или заявленной продукцией нужного
 * товара из другой категории. Предварительный порядок повторяет формулу ранжирования ТЗ: совпадение товара (35 %) —
 * документ со словами запроса или заявленная продукция > ОКВЭД, называющий товар > ОКВЭД группы товаров >
 * документ, привязанный к товару > слова товара в видах деятельности > только категория; регион (20 %).
 * Сведения адаптеров собираются только для верхушки этого порядка.
 */
const candidatesCte = (category: string, product: string, terms: string) => `
  WITH tsq AS (
    SELECT CASE WHEN cardinality(${terms}::text[]) = 0 THEN NULL::tsquery ELSE (
      SELECT string_agg('(' || x::text || ')', ' | ')::tsquery
        FROM (SELECT plainto_tsquery('russian', t) AS x FROM unnest(${terms}::text[]) t) y
       WHERE x::text <> '') END AS q
  ),
  doc_hit AS (
    SELECT d.supplier_id, coalesce(tsq.q IS NOT NULL AND d.search_tsv @@ tsq.q, false) AS by_text
      FROM compliance_documents d, tsq
     WHERE (${product}::text IS NOT NULL AND d.product_id = ${product}::text) OR (tsq.q IS NOT NULL AND d.search_tsv @@ tsq.q)
  ),
  doc_level AS (SELECT supplier_id, bool_or(by_text) AS by_text FROM doc_hit GROUP BY supplier_id),
  prod_hit AS (
    SELECT p.supplier_id,
           max(CASE WHEN p.origin <> 'OKVED' THEN 4 WHEN p.characteristics->>'exact' = 'true' THEN 3 ELSE 2 END) AS lvl
      FROM product_records p
     WHERE ${product}::text IS NOT NULL AND p.product_id = ${product}::text
     GROUP BY p.supplier_id
  ),
  -- Документ только усиливает компанию из выборки: привязка документов к товару по названию шумная
  -- («мебель из ЛДСП» — не плиты ОСБ), поэтому чужие категории добавляют лишь ОКВЭД товара и заявленная продукция
  universe AS (
    SELECT supplier_id FROM product_records WHERE category_id = ${category}
    UNION SELECT supplier_id FROM prod_hit
  )`;

/** Фильтры по данным, региону при строгом фильтре и типу поставщика: $2–$5 в обоих запросах. */
const CANDIDATES_WHERE = `
       AND ($2 = 'all' OR ($2 = 'real' AND s.source_type = 'OFFICIAL') OR ($2 = 'test' AND s.source_type = 'MANUAL_TEST_DATA'))
       AND ($3::text IS NULL OR NOT $4 OR s.region_code = $3)
       AND (NOT $5 OR s.supplier_type IN ('MANUFACTURER', 'UNKNOWN'))`;

export class SupplierRepository {
  constructor(private readonly db: Db) {}

  async candidates(o: CandidateOptions): Promise<SupplierRow[]> {
    const region = o.regionCode && o.regionCode !== 'RU' ? o.regionCode : null;
    const { rows } = await this.db.query(
      `${candidatesCte('$1', '$7', '$9')}
       ${SELECT}
         JOIN universe u ON u.supplier_id = s.id
         LEFT JOIN doc_level dl ON dl.supplier_id = s.id
         LEFT JOIN prod_hit ph ON ph.supplier_id = s.id
         CROSS JOIN tsq
        WHERE true ${CANDIDATES_WHERE}
        ORDER BY
          0.35 * (CASE WHEN dl.by_text OR ph.lvl = 4 THEN 1
                       WHEN ph.lvl = 3 THEN 0.9
                       WHEN ph.lvl = 2 THEN 0.8
                       WHEN dl.supplier_id IS NOT NULL THEN 0.75
                       WHEN tsq.q IS NOT NULL AND s.search_tsv @@ tsq.q THEN 0.7
                       ELSE 0.6 END
                 + CASE WHEN ph.lvl IN (2, 3) AND tsq.q IS NOT NULL AND s.search_tsv @@ tsq.q THEN 0.05 ELSE 0 END)
          + 0.2 * CASE WHEN $3::text IS NULL OR s.region_code = $3 THEN 1 WHEN s.region_code = ANY($6::text[]) THEN 0.6 ELSE 0.2 END DESC,
          (s.supplier_type = 'MANUFACTURER') DESC,
          (s.legal_status = 'ACTIVE') DESC,
          -- полнота профиля: есть сведения о численности и отчётности (см. refreshProfileFlags)
          s.has_employees DESC,
          s.has_revenue DESC,
          s.name
        LIMIT $8`,
      [o.categoryId, o.dataMode, region, o.strictRegion, o.manufacturerOnly, o.neighbors, o.productId, o.limit ?? 150, o.terms ?? []],
    );
    return dedupeSuppliers(rows.map(map));
  }

  async countByCategory(o: Omit<CandidateOptions, 'neighbors' | 'limit'>): Promise<number> {
    const region = o.regionCode && o.regionCode !== 'RU' ? o.regionCode : null;
    const { rows } = await this.db.query<{ n: string }>(
      `${candidatesCte('$1', '$6', '$7')}
       SELECT count(*) AS n FROM suppliers s JOIN universe u ON u.supplier_id = s.id
        WHERE true ${CANDIDATES_WHERE}`,
      [o.categoryId, o.dataMode, region, o.strictRegion, o.manufacturerOnly, o.productId, o.terms ?? []],
    );
    return Number(rows[0].n);
  }

  /** Какие наборы открытых данных загружены и на какую дату. */
  async openDataImports(): Promise<{ dataset: string; source: string; title: string; dataDate: string; rowsMatched: number; rowsTotal: number }[]> {
    const { rows } = await this.db.query(
      `SELECT dataset, source, title, to_char(data_date, 'YYYY-MM-DD') AS data_date, rows_matched, rows_total FROM opendata_imports
        ORDER BY COALESCE(array_position(ARRAY['rsmp','sshr','snr','snrip','debtam','paytax','taxoffence','revexp','rsmppp','rnp','fsa-rds','fsa-rss'], dataset), 99), dataset`,
    );
    return rows.map((r) => ({ dataset: r.dataset, source: r.source, title: r.title, dataDate: r.data_date, rowsMatched: Number(r.rows_matched), rowsTotal: Number(r.rows_total) }));
  }

  async byIds(ids: string[]): Promise<SupplierRow[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.query(`${SELECT} WHERE s.id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id as string, map(r)]));
    return ids.map((id) => byId.get(id)).filter((r): r is SupplierRow => !!r);
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM suppliers');
    return Number(rows[0].n);
  }
}
