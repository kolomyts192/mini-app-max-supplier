import type { Catalog } from '../../catalog/catalog';
import type { Db } from '../../infra/db';
import type { Report } from '../io/reportStore';

export interface Coverage {
  generatedAt: string;
  suppliers: {
    official: number;
    manual: number;
    legalEntities: number;
    individuals: number;
    withOgrn: number;
    active: number;
    manufacturers: number;
    hasEmployees: number;
    hasRevenue: number;
  };
  categories: { id: string; name: string; companies: number; declared: number }[];
  regions: { code: string; name: string; companies: number }[];
  facts: { field: string; source: string; rows: number; suppliers: number }[];
  documents: { source: string; documents: number; suppliers: number; active: number; withProduct: number }[];
  risks: { source: string; kind: string; rows: number }[];
  financials: { source: string; rows: number; suppliers: number }[];
  datasets: { dataset: string; title: string; dataDate: string; rowsTotal: number; rowsMatched: number; importedAt: string }[];
  quarantine: { dataset: string; reason: string; rows: number }[];
}

const num = (v: unknown) => Number(v ?? 0);

/** Покрытие базы реальных поставщиков: категории, регионы, источники сведений, документы и риски. */
export class CoverageAnalyzer {
  constructor(
    private readonly db: Db,
    private readonly catalog: Catalog,
  ) {}

  async analyze(): Promise<Coverage> {
    const [suppliers, categories, regions, facts, documents, risks, financials, datasets, quarantine] = await Promise.all([
      this.db.query(`SELECT count(*) FILTER (WHERE source_type = 'OFFICIAL') AS official,
                            count(*) FILTER (WHERE source_type = 'MANUAL_TEST_DATA') AS manual,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND entity_type = 'LEGAL_ENTITY') AS legal,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND entity_type = 'IP') AS ip,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND ogrn IS NOT NULL) AS with_ogrn,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND legal_status = 'ACTIVE') AS active,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND supplier_type = 'MANUFACTURER') AS manufacturers,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND has_employees) AS has_employees,
                            count(*) FILTER (WHERE source_type = 'OFFICIAL' AND has_revenue) AS has_revenue
                       FROM suppliers`),
      this.db.query(`SELECT p.category_id, count(DISTINCT p.supplier_id) AS companies,
                            count(DISTINCT p.supplier_id) FILTER (WHERE p.origin = 'SME_DECLARED') AS declared
                       FROM product_records p JOIN suppliers s ON s.id = p.supplier_id AND s.source_type = 'OFFICIAL'
                      GROUP BY p.category_id`),
      this.db.query(`SELECT region_code, max(region_name) AS region_name, count(*) AS companies FROM suppliers
                      WHERE source_type = 'OFFICIAL' GROUP BY region_code ORDER BY companies DESC`),
      this.db.query(`SELECT field, source, count(*) AS rows, count(DISTINCT supplier_id) AS suppliers FROM verification_records
                      WHERE is_manual_test_data = false GROUP BY field, source ORDER BY source, field`),
      this.db.query(`SELECT source, count(*) AS documents, count(DISTINCT supplier_id) AS suppliers,
                            count(*) FILTER (WHERE status = 'ACTIVE') AS active, count(*) FILTER (WHERE product_id IS NOT NULL) AS with_product
                       FROM compliance_documents WHERE is_manual_test_data = false GROUP BY source ORDER BY source`),
      this.db.query(`SELECT source, kind, count(*) AS rows FROM risk_signals WHERE is_manual_test_data = false GROUP BY source, kind ORDER BY source, kind`),
      this.db.query(`SELECT source, count(*) AS rows, count(DISTINCT supplier_id) AS suppliers FROM financial_reports
                      WHERE is_manual_test_data = false GROUP BY source ORDER BY source`),
      this.db.query(`SELECT dataset, title, to_char(data_date, 'YYYY-MM-DD') AS data_date, rows_total, rows_matched, imported_at
                       FROM opendata_imports ORDER BY imported_at`),
      this.db.query(`SELECT dataset, reason, count(*) AS rows FROM opendata_quarantine GROUP BY dataset, reason ORDER BY rows DESC`),
    ]);

    const s = suppliers.rows[0];
    const byCategory = new Map(categories.rows.map((r) => [r.category_id as string, r]));
    return {
      generatedAt: new Date().toISOString(),
      suppliers: {
        official: num(s.official), manual: num(s.manual), legalEntities: num(s.legal), individuals: num(s.ip), withOgrn: num(s.with_ogrn),
        active: num(s.active), manufacturers: num(s.manufacturers), hasEmployees: num(s.has_employees), hasRevenue: num(s.has_revenue),
      },
      categories: this.catalog.data.categories
        .map((c) => ({ id: c.id, name: c.name, companies: num(byCategory.get(c.id)?.companies), declared: num(byCategory.get(c.id)?.declared) }))
        .sort((a, b) => b.companies - a.companies),
      regions: regions.rows.map((r) => ({ code: r.region_code, name: this.catalog.region(r.region_code)?.name ?? r.region_name, companies: num(r.companies) })),
      facts: facts.rows.map((r) => ({ field: r.field, source: r.source, rows: num(r.rows), suppliers: num(r.suppliers) })),
      documents: documents.rows.map((r) => ({ source: r.source, documents: num(r.documents), suppliers: num(r.suppliers), active: num(r.active), withProduct: num(r.with_product) })),
      risks: risks.rows.map((r) => ({ source: r.source, kind: r.kind, rows: num(r.rows) })),
      financials: financials.rows.map((r) => ({ source: r.source, rows: num(r.rows), suppliers: num(r.suppliers) })),
      datasets: datasets.rows.map((r) => ({ dataset: r.dataset, title: r.title, dataDate: r.data_date, rowsTotal: num(r.rows_total), rowsMatched: num(r.rows_matched), importedAt: (r.imported_at as Date).toISOString() })),
      quarantine: quarantine.rows.map((r) => ({ dataset: r.dataset, reason: r.reason, rows: num(r.rows) })),
    };
  }
}

const n = (v: number) => v.toLocaleString('ru-RU');
const pct = (part: number, total: number) => (total ? `${((part / total) * 100).toFixed(1)}%` : '—');

export function coverageReport(c: Coverage): Report {
  const s = c.suppliers;
  const markdown = [
    '# Покрытие базы поставщиков',
    '',
    `- Сформирован: ${c.generatedAt}`,
    `- Официальных компаний: **${n(s.official)}** (юрлиц ${n(s.legalEntities)}, ИП ${n(s.individuals)}); ручной тестовой базы: ${n(s.manual)}`,
    `- С ОГРН: ${n(s.withOgrn)} (${pct(s.withOgrn, s.official)}); статус «действует» по реестру МСП: ${n(s.active)} (${pct(s.active, s.official)})`,
    `- Производителей (заявили продукцию): ${n(s.manufacturers)}; со сведениями о численности: ${n(s.hasEmployees)}; с выручкой: ${n(s.hasRevenue)}`,
    '',
    '## Категории',
    '',
    '| Категория | Компаний | Из них заявили продукцию |',
    '|---|---:|---:|',
    ...c.categories.map((x) => `| ${x.name} (\`${x.id}\`) | ${n(x.companies)} | ${n(x.declared)} |`),
    '',
    '## Наборы данных',
    '',
    '| Набор | Название | Дата данных | Записей | Совпало | Загружен |',
    '|---|---|---|---:|---:|---|',
    ...c.datasets.map((d) => `| ${d.dataset} | ${d.title} | ${d.dataDate} | ${n(d.rowsTotal)} | ${n(d.rowsMatched)} | ${d.importedAt.slice(0, 16).replace('T', ' ')} |`),
    '',
    '## Сведения в карточках',
    '',
    '| Источник | Поле | Строк | Компаний |',
    '|---|---|---:|---:|',
    ...c.facts.map((f) => `| ${f.source} | ${f.field} | ${n(f.rows)} | ${n(f.suppliers)} |`),
    ...c.financials.map((f) => `| ${f.source} | financial_reports | ${n(f.rows)} | ${n(f.suppliers)} |`),
    '',
    '## Документы и риски',
    '',
    ...(c.documents.length
      ? c.documents.map((d) => `- ${d.source}: ${n(d.documents)} документов у ${n(d.suppliers)} компаний; действующих ${n(d.active)}; привязано к товару ${n(d.withProduct)} (${pct(d.withProduct, d.documents)})`)
      : ['- документов Росаккредитации нет']),
    ...(c.risks.length ? c.risks.map((r) => `- ${r.source} / ${r.kind}: ${n(r.rows)}`) : ['- риск-сигналов из открытых данных нет']),
    '',
    '## Карантин',
    '',
    ...(c.quarantine.length ? c.quarantine.map((q) => `- ${q.dataset}: ${q.reason} — ${n(q.rows)}`) : ['- пусто']),
    '',
    `## Регионы (${c.regions.length})`,
    '',
    ...c.regions.map((r) => `- ${r.code} ${r.name}: ${n(r.companies)}`),
    '',
  ].join('\n');
  return { json: c, markdown };
}
