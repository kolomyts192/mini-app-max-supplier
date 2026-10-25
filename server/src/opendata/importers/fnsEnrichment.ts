import type { PoolClient } from 'pg';
import { FNS } from '../datasets/openDatasets';
import type { FactValue } from '../domain/fact';
import type { LatestFile } from '../io/datasetCache';
import {
  DebtParser,
  EmployeesParser,
  IpTaxRegimeParser,
  PaytaxParser,
  RevenueParser,
  SupportParser,
  type SupportMeasure,
  SupportSummary,
  TaxOffenceParser,
  TaxRegimeParser,
} from '../parsing/fnsParsers';
import { rub } from '../parsing/format';
import { FinancialReportWriter } from '../persistence/sourceWriters';
import { AbstractEnrichmentImporter, type EnrichmentDeps, FactEnrichmentImporter } from './enrichmentImporter';

/** Наборы «Прозрачного бизнеса» ФНС и реестр поддержки МСП: по классу на набор. */

/** Среднесписочная численность. */
export class EmployeesImporter extends FactEnrichmentImporter<{ count: string; date: string | null }, { count: string; date: string | null }> {
  protected readonly field = 'employees_count';

  constructor(d: EnrichmentDeps) {
    super(FNS.sshr, new EmployeesParser(), d);
  }

  protected accumulate(_prev: unknown, item: { count: string; date: string | null }) {
    return item;
  }

  protected toFact(e: { count: string; date: string | null }): FactValue {
    return { value: e.count, notes: `Среднесписочная численность на ${e.date ?? 'отчётную дату'}` };
  }
}

/** Спецрежимы юрлиц. Юрлица, которых нет в наборе, применяют общую систему налогообложения. */
export class TaxRegimeImporter extends FactEnrichmentImporter<string[], string[]> {
  protected readonly field = 'tax_regime';
  protected readonly scope = 'LEGAL_ENTITY';

  constructor(d: EnrichmentDeps) {
    super(FNS.snr, new TaxRegimeParser(), d);
  }

  protected accumulate(_prev: unknown, item: string[]) {
    return item;
  }

  protected toFact(regimes: string[]): FactValue {
    return { value: regimes.join(', '), notes: 'Специальный налоговый режим' };
  }

  protected fallback(): FactValue {
    return { value: 'ОСН (специальный режим не применяется)', notes: 'Компании нет в наборе спецрежимов ФНС' };
  }
}

/** Спецрежимы ИП. ИП без записи в наборе может применять ОСН — значение по умолчанию не ставим. */
export class IpTaxRegimeImporter extends FactEnrichmentImporter<string[], string[]> {
  protected readonly field = 'tax_regime';
  protected readonly scope = 'IP';

  constructor(d: EnrichmentDeps) {
    super(FNS.snrip, new IpTaxRegimeParser(), d);
  }

  protected accumulate(prev: string[] | undefined, item: string[]) {
    return [...new Set([...(prev ?? []), ...item])];
  }

  protected toFact(regimes: string[]): FactValue {
    return { value: regimes.join(', '), notes: 'Специальный налоговый режим индивидуального предпринимателя' };
  }
}

/** Задолженность по налогам: суммируется по всем документам компании. Набор только по юрлицам. */
export class DebtImporter extends FactEnrichmentImporter<number, number> {
  protected readonly field = 'tax_debt';
  protected readonly scope = 'LEGAL_ENTITY';

  constructor(d: EnrichmentDeps) {
    super(FNS.debtam, new DebtParser(), d);
  }

  protected accumulate(prev: number | undefined, sum: number) {
    return (prev ?? 0) + sum;
  }

  protected toFact(sum: number): FactValue {
    return sum ? { value: rub(sum, 2), notes: 'Недоимка, пени и штрафы по данным ФНС' } : this.fallback();
  }

  protected fallback(): FactValue {
    return { value: 'Нет в наборе задолженностей', notes: 'Задолженность по данным ФНС не выявлена' };
  }
}

/** Уплаченные налоги и взносы за прошлый год. */
export class PaytaxImporter extends FactEnrichmentImporter<FactValue, FactValue> {
  protected readonly field = 'taxes_paid';

  constructor(d: EnrichmentDeps) {
    super(FNS.paytax, new PaytaxParser(), d);
  }

  protected accumulate(_prev: unknown, item: FactValue) {
    return item;
  }

  protected toFact(v: FactValue): FactValue {
    return v;
  }
}

/** Налоговые правонарушения: сумма штрафов за год. Набор только по юрлицам. */
export class TaxOffenceImporter extends FactEnrichmentImporter<{ sum: number; year: string }, { sum: number; year: string }> {
  protected readonly field = 'tax_offences';
  protected readonly scope = 'LEGAL_ENTITY';

  constructor(d: EnrichmentDeps) {
    super(FNS.taxoffence, new TaxOffenceParser(), d);
  }

  protected accumulate(prev: { sum: number } | undefined, item: { sum: number; year: string }) {
    return { sum: (prev?.sum ?? 0) + item.sum, year: item.year };
  }

  protected toFact(f: { sum: number; year: string }): FactValue {
    return { value: `Штрафы ${rub(f.sum, 2)} за ${f.year} год`, notes: 'Налоговые правонарушения и меры ответственности по данным ФНС' };
  }

  protected fallback(): FactValue {
    return { value: 'Нет в наборе правонарушений', notes: 'Штрафов за налоговые правонарушения по данным ФНС нет' };
  }
}

/** Реестр МСП — получателей поддержки: число мер, сумма и последняя мера. */
export class SupportImporter extends FactEnrichmentImporter<SupportMeasure[], SupportSummary> {
  protected readonly field = 'sme_support';

  constructor(d: EnrichmentDeps) {
    super(FNS.rsmppp, new SupportParser(), d);
  }

  protected accumulate(prev: SupportSummary | undefined, measures: SupportMeasure[]) {
    return (prev ?? new SupportSummary()).add(measures);
  }

  protected toFact(s: SupportSummary): FactValue {
    return s.toFact();
  }
}

type Revenue = { year: number; revenue: number; expenses: number };

/** Доходы и расходы по бухотчётности → financial_reports (в рублях). */
export class RevenueImporter extends AbstractEnrichmentImporter<Revenue, Revenue> {
  private readonly writer = new FinancialReportWriter();

  constructor(d: EnrichmentDeps) {
    super(FNS.revexp, new RevenueParser(), d);
  }

  protected accumulate(_prev: unknown, item: Revenue) {
    return item;
  }

  protected persist(client: PoolClient, values: ReadonlyMap<string, Revenue>, meta: LatestFile): Promise<number> {
    const checkedAt = `${meta.dataDate}T00:00:00Z`;
    const rows = [...values.entries()].map(([supplierId, r]) => ({ supplierId, ...r, sourceUrl: this.dataset.passport, checkedAt }));
    return this.writer.replaceSource(client, this.dataset.source, rows);
  }
}
