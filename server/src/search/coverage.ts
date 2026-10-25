import type { Coverage } from './model';

/** Реестры, как их видит пользователь: несколько внутренних источников — одна подпись. */
const GROUPS: { id: string; label: string; sources: string[] }[] = [
  { id: 'sme', label: 'реестр МСП', sources: ['SME_REGISTRY'] },
  { id: 'fns', label: 'ФНС: налоги и численность', sources: ['FNS_PB', 'FNS_REVEXP'] },
  { id: 'egrul', label: 'ЕГРЮЛ', sources: ['FNS_EGRUL'] },
  { id: 'fsa', label: 'Росаккредитация', sources: ['FSA_CERT', 'FSA_DECL'] },
  { id: 'gisp', label: 'ГИСП', sources: ['GISP', 'GISP_PP719'] },
  { id: 'rnp', label: 'РНП', sources: ['FAS_RNP'] },
  { id: 'fedresurs', label: 'ЕФРСБ', sources: ['FEDRESURS'] },
];

export interface CoverageSummary {
  /** Реестры, по которым сведения реально проверены: «реестр МСП», «ЕГРЮЛ»… */
  checked: string[];
  /** Реестры, которые пока не подключены. */
  missing: string[];
  /** Идентификаторы групп с данными: фильтры по неподключённым реестрам скрываются по ним. */
  connected: string[];
}

/** Сводка для ответа поиска. null — покрыто всё (ручная тестовая база). */
export function summarizeCoverage(coverage: Coverage): CoverageSummary {
  const has = (g: (typeof GROUPS)[number]) => coverage === null || g.sources.some((s) => coverage.has(s));
  return {
    checked: GROUPS.filter(has).map((g) => g.label),
    missing: GROUPS.filter((g) => !has(g)).map((g) => g.label),
    connected: GROUPS.filter(has).map((g) => g.id),
  };
}
