import type { Catalog } from '../catalog/catalog';
import type { Db } from '../infra/db';
import type { DataMode } from '../search/repository';
import type { OpenDataImport } from '../search/service';
import type { AnalyticsService } from './analytics';

export interface Overview {
  generatedAt: string;
  dataMode: DataMode;
  totals: { companies: number; regions: number; categories: number; withReports: number; withEmployees: number; declaredManufacturers: number; ip: number };
  byCategory: { id: string; name: string; count: number }[];
  byRegion: { code: string; name: string; count: number }[];
  sme: { micro: number; small: number; medium: number; unknown: number };
  imports: OpenDataImport[];
  notConnected: { id: string; name: string; reason: string }[];
  /** Источники с живым API: сколько компаний уже проверено. */
  live: { id: string; name: string; detail: string; checked: number }[];
  product: { periodDays: number; searches: number; successRate: number | null; nonEmptyShare: number | null; avgLatencyMs: number | null };
}

const NOT_CONNECTED = [
  { id: 'FNS_EGRUL', reason: 'подключается бесплатным ключом API DaData — ключ ещё не задан' },
  { id: 'GISP', reason: 'витрины ГИСП выдаются по заявке организации (доступ по JWT); сайт закрыт защитой от автоматических запросов' },
  { id: 'FSA_DECL', reason: 'импорт открытых данных Росаккредитации готов: архивы скачиваются через браузер с российского IP' },
  { id: 'FAS_RNP', reason: 'открытый набор ФАС не обновляется с марта 2021 года; действующий реестр ведётся в ЕИС — доступ по токену организации' },
  { id: 'FEDRESURS', reason: 'API ЕФРСБ только по договору с оператором; банкротство из ЕГРЮЛ видно при подключённом ЕГРЮЛ' },
  { id: 'GIR_BO', reason: 'массовая выгрузка ГИР БО — по договору с ФНС; доходы и расходы берутся из открытых данных ФНС' },
];

const LIVE_DETAIL: Record<string, string> = {
  FNS_EGRUL: 'по API DaData: статус, ОГРН, руководитель, недостоверность — для компаний в выдаче',
  GISP: 'витрины ГИСП по JWT',
};

/** Сводка по базе для дашборда. Только агрегаты — без персональных данных. Кэш 5 минут. */
export class OverviewService {
  private cache: { at: number; mode: DataMode; data: Overview } | null = null;

  constructor(
    private readonly db: Db,
    private readonly catalog: Catalog,
    private readonly analytics: AnalyticsService,
    private readonly imports: () => Promise<OpenDataImport[]>,
    private readonly mode: () => DataMode,
    private readonly liveSources: Set<string> = new Set(),
  ) {}

  async get(): Promise<Overview> {
    const mode = this.mode();
    if (this.cache && this.cache.mode === mode && Date.now() - this.cache.at < 300_000) return this.cache.data;
    const filter = mode === 'real' ? `source_type = 'OFFICIAL'` : mode === 'test' ? `source_type = 'MANUAL_TEST_DATA'` : 'true';

    const [totals, cats, regions, reports, employees, imports, metrics, egrulChecked] = await Promise.all([
      this.db.query(
        `SELECT count(*)::int AS companies, count(DISTINCT region_code)::int AS regions,
                count(*) FILTER (WHERE supplier_type = 'MANUFACTURER')::int AS declared,
                count(*) FILTER (WHERE entity_type = 'IP')::int AS ip,
                count(*) FILTER (WHERE sme_status = 'MICRO')::int AS micro,
                count(*) FILTER (WHERE sme_status = 'SMALL')::int AS small,
                count(*) FILTER (WHERE sme_status = 'MEDIUM')::int AS medium,
                count(*) FILTER (WHERE sme_status NOT IN ('MICRO', 'SMALL', 'MEDIUM'))::int AS unknown
           FROM suppliers WHERE ${filter} AND legal_status <> 'INACTIVE'`,
      ),
      this.db.query(
        `SELECT p.category_id, count(DISTINCT p.supplier_id)::int AS n
           FROM product_records p JOIN suppliers s ON s.id = p.supplier_id
          WHERE ${filter.replace('source_type', 's.source_type')} AND s.legal_status <> 'INACTIVE'
          GROUP BY 1`,
      ),
      this.db.query(
        `SELECT region_code, max(region_name) AS region_name, count(*)::int AS n
           FROM suppliers WHERE ${filter} AND legal_status <> 'INACTIVE'
          GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT 12`,
      ),
      this.db.query(
        `SELECT count(DISTINCT f.supplier_id)::int AS n FROM financial_reports f JOIN suppliers s ON s.id = f.supplier_id
          WHERE ${filter.replace('source_type', 's.source_type')} AND f.revenue > 0`,
      ),
      this.db.query(
        `SELECT count(DISTINCT v.supplier_id)::int AS n FROM verification_records v JOIN suppliers s ON s.id = v.supplier_id
          WHERE ${filter.replace('source_type', 's.source_type')} AND v.field = 'employees_count' AND v.value ~ '^[1-9][0-9]*$'`,
      ),
      this.imports(),
      this.analytics.metrics(30).catch(() => null),
      this.db.query(
        `SELECT count(DISTINCT v.supplier_id)::int AS n FROM verification_records v
          WHERE v.source = 'FNS_EGRUL' AND v.is_manual_test_data = false AND v.field IN ('legal_status', 'egrul_not_found')`,
      ),
    ]);

    const t = totals.rows[0];
    const byCat = new Map<string, number>(cats.rows.map((r) => [r.category_id as string, r.n as number]));
    const data: Overview = {
      generatedAt: new Date().toISOString(),
      dataMode: mode,
      totals: {
        companies: t.companies,
        regions: t.regions,
        categories: this.catalog.data.categories.length,
        withReports: reports.rows[0].n,
        withEmployees: employees.rows[0].n,
        declaredManufacturers: t.declared,
        ip: t.ip,
      },
      byCategory: this.catalog.data.categories
        .map((c) => ({ id: c.id, name: c.name, count: byCat.get(c.id) ?? 0 }))
        .sort((a, b) => b.count - a.count),
      byRegion: regions.rows.map((r) => ({ code: r.region_code, name: this.catalog.region(r.region_code)?.name ?? r.region_name, count: r.n })),
      sme: { micro: t.micro, small: t.small, medium: t.medium, unknown: t.unknown },
      imports,
      notConnected:
        mode === 'test'
          ? []
          : NOT_CONNECTED.filter((n) => !imports.some((i) => i.source === n.id) && !this.liveSources.has(n.id)).map((n) => ({ ...n, name: this.catalog.source(n.id).name })),
      live:
        mode === 'test'
          ? []
          : [...this.liveSources].map((id) => ({
              id,
              name: this.catalog.source(id).name,
              detail: LIVE_DETAIL[id] ?? 'официальный API',
              checked: id === 'FNS_EGRUL' ? egrulChecked.rows[0].n : 0,
            })),
      product: {
        periodDays: 30,
        searches: metrics?.searchesStarted ?? 0,
        successRate: metrics?.searchSuccessRate ?? null,
        nonEmptyShare: metrics?.nonEmptyShare ?? null,
        avgLatencyMs: metrics?.avgTimeToFirstResultMs ?? null,
      },
    };
    this.cache = { at: Date.now(), mode, data };
    return data;
  }
}
