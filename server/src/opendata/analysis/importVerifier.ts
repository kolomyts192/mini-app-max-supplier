import type { Db } from '../../infra/db';
import { FNS_DATASETS } from '../datasets/openDatasets';
import type { Report } from '../io/reportStore';
import type { Coverage } from './coverageAnalyzer';

export interface Check {
  id: string;
  title: string;
  /** error — критерий приёмки, warning — стоит посмотреть, info — справочно. */
  severity: 'error' | 'warning' | 'info';
  ok: boolean;
  actual: string;
  expected: string;
}

const n = (v: number) => v.toLocaleString('ru-RU');

/** Проверка базы после импорта по критериям приёмки: дубли, пустые реквизиты, категории, наборы, идемпотентность. */
export class ImportVerifier {
  constructor(private readonly db: Db) {}

  async verify(c: Coverage): Promise<Check[]> {
    const count = async (sql: string) => Number((await this.db.query<{ n: string }>(sql)).rows[0].n);
    const [dupInn, dupOgrn, badRegion, noName, noProducts, dupFacts, notSeen] = await Promise.all([
      count(`SELECT count(*) AS n FROM (SELECT inn FROM suppliers GROUP BY inn HAVING count(*) > 1) d`),
      count(`SELECT count(*) AS n FROM (SELECT ogrn FROM suppliers WHERE ogrn IS NOT NULL GROUP BY ogrn HAVING count(*) > 1) d`),
      count(`SELECT count(*) AS n FROM suppliers WHERE source_type = 'OFFICIAL' AND (region_code !~ '^\\d{2}$' OR coalesce(region_name, '') = '')`),
      count(`SELECT count(*) AS n FROM suppliers WHERE source_type = 'OFFICIAL' AND btrim(regexp_replace(name, '^ИП', '')) = ''`),
      count(`SELECT count(*) AS n FROM suppliers s WHERE s.source_type = 'OFFICIAL' AND NOT EXISTS (SELECT 1 FROM product_records p WHERE p.supplier_id = s.id)`),
      count(`SELECT count(*) AS n FROM (SELECT supplier_id, field, source FROM verification_records WHERE is_manual_test_data = false
                                         GROUP BY supplier_id, field, source HAVING count(*) > 1) d`),
      count(`SELECT count(*) AS n FROM suppliers WHERE source_type = 'OFFICIAL' AND legal_status = 'UNKNOWN'`),
    ]);
    const official = c.suppliers.official;
    const ogrnShare = official ? c.suppliers.withOgrn / official : 0;
    const nonEmpty = c.categories.filter((x) => x.companies > 0).length;
    const large = c.categories.filter((x) => x.companies >= 100).length;
    const loaded = new Set(c.datasets.map((d) => d.dataset));
    const fnsLoaded = FNS_DATASETS.filter((d) => loaded.has(d.id)).length;
    const fsaLoaded = ['fsa-rds', 'fsa-rss'].filter((d) => loaded.has(d));
    const quarantined = c.quarantine.reduce((s, q) => s + q.rows, 0);

    return [
      { id: 'official', title: 'Официальные компании в базе', severity: 'error', ok: official > 0, actual: n(official), expected: '> 0' },
      { id: 'dup_inn', title: 'Дубли ИНН', severity: 'error', ok: dupInn === 0, actual: n(dupInn), expected: '0' },
      { id: 'dup_ogrn', title: 'Дубли ОГРН', severity: 'error', ok: dupOgrn === 0, actual: n(dupOgrn), expected: '0' },
      { id: 'region', title: 'Пустой или неверный регион', severity: 'error', ok: badRegion === 0, actual: n(badRegion), expected: '0' },
      { id: 'name', title: 'Пустое наименование', severity: 'error', ok: noName === 0, actual: n(noName), expected: '0' },
      { id: 'ogrn_share', title: 'Доля компаний с ОГРН', severity: 'error', ok: ogrnShare >= 0.99, actual: `${(ogrnShare * 100).toFixed(2)}%`, expected: '≥ 99%' },
      { id: 'categories', title: 'Непустые категории', severity: 'error', ok: nonEmpty === c.categories.length, actual: `${nonEmpty} из ${c.categories.length}`, expected: `${c.categories.length} из ${c.categories.length}` },
      { id: 'categories_100', title: 'Категории со 100+ компаниями', severity: 'error', ok: large >= 15, actual: String(large), expected: '≥ 15' },
      { id: 'fns', title: 'Загружены наборы ФНС', severity: 'error', ok: fnsLoaded === FNS_DATASETS.length, actual: `${fnsLoaded} из ${FNS_DATASETS.length}`, expected: `${FNS_DATASETS.length} из ${FNS_DATASETS.length}` },
      { id: 'dup_facts', title: 'Повторы сведений (поставщик + поле + источник)', severity: 'error', ok: dupFacts === 0, actual: n(dupFacts), expected: '0 — импорт идемпотентен' },
      { id: 'no_products', title: 'Компании без категории (не видны в поиске)', severity: 'warning', ok: noProducts === 0, actual: n(noProducts), expected: '0' },
      { id: 'fsa', title: 'Наборы Росаккредитации', severity: 'warning', ok: fsaLoaded.length === 2, actual: fsaLoaded.join(', ') || 'нет', expected: 'fsa-rds, fsa-rss' },
      { id: 'not_seen', title: 'Нет в свежей версии реестра МСП (статус не подтверждён)', severity: 'info', ok: true, actual: n(notSeen), expected: 'справочно' },
      { id: 'quarantine', title: 'Записей в карантине', severity: 'info', ok: true, actual: n(quarantined), expected: 'справочно' },
    ];
  }
}

export function verificationReport(checks: Check[], c: Coverage): Report {
  const failed = checks.filter((x) => !x.ok && x.severity === 'error');
  const mark = (x: Check) => (x.ok ? 'да' : x.severity === 'error' ? '**нет**' : 'нет');
  const markdown = [
    '# Проверка базы поставщиков',
    '',
    `- Сформирован: ${c.generatedAt}`,
    `- Итог: ${failed.length ? `**не пройдено ${failed.length} критериев**` : 'все критерии пройдены'}`,
    '',
    '| Проверка | Значение | Ожидается | Пройдено |',
    '|---|---:|---|---|',
    ...checks.map((x) => `| ${x.title} | ${x.actual} | ${x.expected} | ${x.severity === 'info' ? '—' : mark(x)} |`),
    '',
  ].join('\n');
  return { json: { checks, failed: failed.map((x) => x.id) }, markdown };
}
