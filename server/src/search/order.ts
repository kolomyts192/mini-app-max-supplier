import type { SupplierSummary } from './dto';
import type { ProductBasis } from './facts';
import type { SupplierRow } from './model';

/** Насколько основание подтверждает именно товар: документ и заявленная продукция выше, чем только ОКВЭД. */
const BASIS_TIER: Record<ProductBasis, number> = {
  document: 3,
  declared: 3,
  catalog: 3,
  document_linked: 2,
  okved_exact: 1,
  okved_group: 1,
  okved_text: 0,
  category: 0,
};

const LEGAL_FORMS = /^(общество с ограниченной ответственностью|акционерное общество|публичное акционерное общество|непубличное акционерное общество|ооо|оао|зао|пао|нао|ао)\s+/u;

/** Название без формы собственности, кавычек, дефисов и пробелов: «1-ЛКЗ РУ» и «1ЛКЗ РУ» дают один ключ. */
export function cloneKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(LEGAL_FORMS, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Порядок выдачи при равном балле: сильнее основание товара, больше выручка, больше сотрудников,
 * старше регистрация; название — только в самом конце, чтобы порядок был стабильным.
 */
export class ResultOrder {
  private readonly rows: Map<string, SupplierRow>;

  constructor(rows: SupplierRow[]) {
    this.rows = new Map(rows.map((r) => [r.id, r]));
  }

  compare = (a: SupplierSummary, b: SupplierSummary): number => {
    if (b.score !== a.score) return b.score - a.score;
    const tier = BASIS_TIER[b.match.basis] - BASIS_TIER[a.match.basis];
    if (tier) return tier;
    const ra = this.rows.get(a.id);
    const rb = this.rows.get(b.id);
    const revenue = (rb?.last_revenue ?? 0) - (ra?.last_revenue ?? 0);
    if (revenue) return revenue;
    const staff = (rb?.employees ?? 0) - (ra?.employees ?? 0);
    if (staff) return staff;
    const da = ra?.registration_date ?? '9999';
    const db = rb?.registration_date ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  };

  /**
   * Клоны — юрлица с одним и тем же названием в одном регионе («1-ЛКЗ РУ» / «1ЛКЗ РУ»): в выдаче остаётся лучшая
   * из них. ИП не склеиваем: совпадение ФИО не значит, что это одно лицо.
   */
  static withoutClones(list: SupplierSummary[]): SupplierSummary[] {
    const seen = new Set<string>();
    return list.filter((s) => {
      if (s.entityType !== 'LEGAL_ENTITY') return true;
      const key = `${s.region.code}:${cloneKey(s.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
