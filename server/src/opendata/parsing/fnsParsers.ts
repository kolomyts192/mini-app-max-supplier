import { plural } from '../../catalog/text';
import type { FactValue } from '../domain/fact';
import { allTagAttrs, tagAttrs } from '../io/xmlStream';
import { isoDate, prettyName, rub, ruDate, shortOrgForm, shortTaxName } from './format';

/** Разбор документа одного набора «Прозрачного бизнеса» ФНС. */
export interface FnsDocumentParser<T> {
  /** ИНН компании, к которой относятся сведения документа. */
  innOf(doc: string): string | undefined;
  /** null — в документе нет значимых сведений. */
  parse(doc: string): T | null;
}

/** Налоговые наборы: сведения о налогоплательщике — первый ИННЮЛ/ИННФЛ документа. */
abstract class TaxpayerParser<T> implements FnsDocumentParser<T> {
  innOf(doc: string): string | undefined {
    return /ИНН(?:ЮЛ|ФЛ)="(\d+)"/.exec(doc)?.[1];
  }

  abstract parse(doc: string): T | null;

  /** Год, на который составлены сведения (атрибут ДатаСост документа). */
  protected stateYear(doc: string): string {
    return (tagAttrs(doc, 'Документ')?.ДатаСост ?? '').slice(-4);
  }
}

/** Среднесписочная численность (7707329152-sshr2019). */
export class EmployeesParser extends TaxpayerParser<{ count: string; date: string | null }> {
  parse(doc: string) {
    const count = tagAttrs(doc, 'СведССЧР')?.КолРаб;
    return count ? { count, date: tagAttrs(doc, 'Документ')?.ДатаСост ?? null } : null;
  }
}

/** Специальные налоговые режимы юрлиц (7707329152-snr). В наборе только те, кто применяет спецрежим. */
export class TaxRegimeParser extends TaxpayerParser<string[]> {
  parse(doc: string) {
    const a = tagAttrs(doc, 'СведСНР') ?? {};
    const list = [a.ПризнУСН === '1' && 'УСН', a.ПризнАУСН === '1' && 'АУСН', a.ПризнЕСХН === '1' && 'ЕСХН', a.ПризнСРП === '1' && 'СРП'].filter((x): x is string => !!x);
    return list.length ? list : null;
  }
}

/** Коды спецрежимов в наборе ФНС по ИП (7707329152-snrip). */
const IP_REGIMES: Record<string, string> = { '1': 'УСН', '2': 'АУСН', '3': 'ЕСХН', '4': 'ПСН', '5': 'НПД' };

/** Специальные налоговые режимы ИП (7707329152-snrip). */
export class IpTaxRegimeParser extends TaxpayerParser<string[]> {
  parse(doc: string) {
    const list = [...new Set(allTagAttrs(doc, 'СведСНР').map((a) => IP_REGIMES[a.ПризнСНР ?? '']).filter(Boolean))];
    return list.length ? list : null;
  }
}

/** Задолженность по налогам (7707329152-debtam): сумма недоимки, пеней и штрафов по всем налогам. */
export class DebtParser extends TaxpayerParser<number> {
  parse(doc: string) {
    return allTagAttrs(doc, 'СведНедоим').reduce((acc, a) => acc + Number(a.ОбщСумНедоим ?? 0), 0);
  }
}

/** Уплаченные налоги за год: итог и крупнейшие платежи (7707329152-paytax). */
export class PaytaxParser extends TaxpayerParser<FactValue> {
  parse(doc: string): FactValue {
    const items = allTagAttrs(doc, 'СвУплСумНал').map((a) => ({ name: shortTaxName(a.НаимНалог ?? ''), sum: Number(a.СумУплНал ?? 0) }));
    const total = items.reduce((s, i) => s + i.sum, 0);
    const year = this.stateYear(doc);
    const top = items
      .filter((i) => i.sum > 0)
      .sort((a, b) => b.sum - a.sum)
      .slice(0, 3)
      .map((i) => `${i.name} — ${rub(i.sum)}`)
      .join('; ');
    return {
      value: total > 0 ? `${rub(total)} за ${year} год` : `Уплат нет за ${year} год`,
      notes: top ? `Крупнейшие платежи: ${top}` : 'Налоги, сборы и страховые взносы по данным ФНС',
    };
  }
}

/** Налоговые правонарушения (7707329152-taxoffence): сумма штрафов за год. */
export class TaxOffenceParser extends TaxpayerParser<{ sum: number; year: string }> {
  parse(doc: string) {
    return { sum: allTagAttrs(doc, 'СведНаруш').reduce((acc, a) => acc + Number(a.СумШтраф ?? 0), 0), year: this.stateYear(doc) };
  }
}

/** Доходы и расходы по бухотчётности (7707329152-revexp), в рублях. */
export class RevenueParser extends TaxpayerParser<{ year: number; revenue: number; expenses: number }> {
  parse(doc: string) {
    const a = tagAttrs(doc, 'СведДохРасх') ?? {};
    const year = Number(this.stateYear(doc)) || new Date().getUTCFullYear() - 1;
    return { year, revenue: Math.round(Number(a.СумДоход ?? 0)), expenses: Math.round(Number(a.СумРасход ?? 0)) };
  }
}

export interface SupportMeasure {
  date: string;
  form: string;
  kind: string;
  provider: string;
  /** Размер в рублях; null — поддержка не денежная. */
  amount: number | null;
  violation: boolean;
}

/** Реестр МСП — получателей поддержки (7707329152-rsmppp): меры поддержки одного получателя. */
export class SupportParser implements FnsDocumentParser<SupportMeasure[]> {
  /** ИНН получателя — в СвЮЛ или СвФЛ; ИННЮЛ внутри СвПредПод принадлежит органу поддержки. */
  innOf(doc: string): string | undefined {
    return tagAttrs(doc, 'СвЮЛ')?.ИННЮЛ ?? tagAttrs(doc, 'СвФЛ')?.ИННФЛ;
  }

  parse(doc: string): SupportMeasure[] | null {
    const measures = doc
      .split('<СвПредПод')
      .slice(1)
      .map((seg) => {
        const part = `<СвПредПод${seg}`;
        const a = tagAttrs(part, 'СвПредПод') ?? {};
        const size = tagAttrs(part, 'РазмПод');
        return {
          date: isoDate(a.ДатаПрин) ?? isoDate(a.ДатаСвед) ?? '',
          form: tagAttrs(part, 'ФормПод')?.НаимФорм ?? '',
          kind: tagAttrs(part, 'ВидПод')?.НаимВид ?? '',
          provider: shortOrgForm(prettyName(a.НаимОрг, a.НаимОрг)),
          amount: size?.ЕдПод === '1' ? Number(size.РазмПод ?? 0) : null,
          violation: a.ИнфНаруш === '1',
        };
      });
    return measures.length ? measures : null;
  }
}

/** Сводка мер поддержки компании по всем документам реестра. */
export class SupportSummary {
  count = 0;
  rub = 0;
  violation = false;
  last: Omit<SupportMeasure, 'violation'> | null = null;

  add(measures: SupportMeasure[]): this {
    for (const { violation, ...m } of measures) {
      this.count += 1;
      if (m.amount) this.rub += m.amount;
      if (violation) this.violation = true;
      if (!this.last || m.date > this.last.date) this.last = m;
    }
    return this;
  }

  toFact(): FactValue {
    const parts = [`${this.count} ${plural(this.count, ['мера', 'меры', 'мер'])} поддержки`];
    if (this.rub > 0) parts.push(`${rub(this.rub)} в денежном выражении`);
    if (this.violation) parts.push('есть сведения о нарушении порядка и условий поддержки');
    const l = this.last;
    const last = l ? `Последняя — ${[l.form.toLowerCase(), l.kind.toLowerCase()].filter(Boolean).join(': ')}, ${ruDate(l.date)}, ${l.provider}${l.amount ? `, ${rub(l.amount)}` : ''}` : null;
    return { value: parts.join('; '), notes: last };
  }
}
