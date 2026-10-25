import type { Catalog } from '../../catalog/catalog';

/**
 * Сопоставление ОКВЭД и ОКПД2 с категориями и товарами справочника (правила okvedRules в data/catalog.json).
 * ОКВЭД даёт только совпадение по категории и «профильный вид деятельности».
 * Статус производителя по одному ОКВЭД не присваивается (раздел 16 ТЗ).
 */
interface CompiledRule {
  prefix: string;
  category: string;
  name?: RegExp;
}

interface CompiledProductRule extends CompiledRule {
  productId: string;
  exact: boolean;
}

/** Товар справочника, к которому компания относится по основному ОКВЭД. */
export interface OkvedProductMatch {
  productId: string;
  categoryId: string;
  /** Код ОКВЭД называет именно этот товар, а не группу товаров. */
  exact: boolean;
}

const matchesPrefix = (code: string, prefix: string) => code === prefix || code.startsWith(`${prefix}.`);

export class CatalogClassifier {
  private static readonly instances = new WeakMap<Catalog, CatalogClassifier>();
  private readonly rules: CompiledRule[];
  private readonly productRules: CompiledProductRule[];
  private readonly products: { okpd2: string; productId: string; categoryId: string }[];

  private constructor(catalog: Catalog) {
    const compile = (r: { prefix: string; name?: string }, category: string): CompiledRule => ({ prefix: r.prefix, category, name: r.name ? new RegExp(r.name, 'iu') : undefined });
    this.rules = catalog.data.categories.flatMap((c) => (c.okvedRules ?? []).map((r) => compile(r, c.id)));
    this.productRules = catalog.data.categories.flatMap((c) =>
      c.products.flatMap((p) => (p.okvedRules ?? []).map((r) => ({ ...compile(r, c.id), productId: p.id, exact: !!r.exact }))),
    );
    this.products = catalog.data.categories.flatMap((c) => c.products.filter((p) => p.okpd2).map((p) => ({ okpd2: p.okpd2, productId: p.id, categoryId: c.id })));
  }

  /** Один классификатор на справочник: правила компилируются один раз. */
  static for(catalog: Catalog): CatalogClassifier {
    let instance = this.instances.get(catalog);
    if (!instance) {
      instance = new CatalogClassifier(catalog);
      this.instances.set(catalog, instance);
    }
    return instance;
  }

  categoriesForOkved(code: string | undefined, name: string | undefined): string[] {
    if (!code) return [];
    const out = new Set<string>();
    for (const r of this.rules) {
      if (!matchesPrefix(code, r.prefix)) continue;
      if (r.name && !r.name.test(name ?? '')) continue;
      out.add(r.category);
    }
    return [...out];
  }

  /** Быстрая проверка до полного разбора документа реестра. */
  okvedMayMatch(code: string): boolean {
    return this.rules.some((r) => matchesPrefix(code, r.prefix)) || this.productRules.some((r) => matchesPrefix(code, r.prefix));
  }

  /** Товары справочника по основному ОКВЭД; у товара — самое сильное из подошедших правил. */
  productsForOkved(code: string | undefined, name: string | undefined): OkvedProductMatch[] {
    if (!code) return [];
    const out = new Map<string, OkvedProductMatch>();
    for (const r of this.productRules) {
      if (!matchesPrefix(code, r.prefix) || (r.name && !r.name.test(name ?? ''))) continue;
      const prev = out.get(r.productId);
      if (!prev || (r.exact && !prev.exact)) out.set(r.productId, { productId: r.productId, categoryId: r.category, exact: r.exact });
    }
    return [...out.values()];
  }

  /** Заявленная продукция (ОКПД2) → конкретные товары справочника. */
  productsForOkpd2(code: string | undefined): { productId: string; categoryId: string }[] {
    if (!code) return [];
    return this.products.filter((p) => matchesPrefix(code, p.okpd2)).map(({ productId, categoryId }) => ({ productId, categoryId }));
  }
}

export const categoriesForOkved = (code: string | undefined, name: string | undefined, catalog: Catalog) => CatalogClassifier.for(catalog).categoriesForOkved(code, name);
export const okvedMayMatch = (code: string, catalog: Catalog) => CatalogClassifier.for(catalog).okvedMayMatch(code);
export const productsForOkpd2 = (code: string | undefined, catalog: Catalog) => CatalogClassifier.for(catalog).productsForOkpd2(code);
