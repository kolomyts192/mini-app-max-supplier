import type { Catalog } from '../../catalog/catalog';
import type { Company } from '../domain/company';
import { freshness, type SupplierFact } from '../domain/fact';
import { ruDate } from '../parsing/format';
import { SupplierTypeAssessor } from '../parsing/rsmpParser';
import type { ProductWriteRow } from '../persistence/productBatchWriter';
import type { SupplierWriteRow } from '../persistence/supplierBatchWriter';
import type { ByInn } from './datasetImporter';

export interface RsmpRows {
  suppliers: SupplierWriteRow[];
  products: ByInn<ProductWriteRow>[];
  facts: ByInn<SupplierFact>[];
}

/**
 * Компании реестра МСП → строки поставщиков, продукции и официальных сведений.
 * Каждое сведение хранит источник и дату набора (раздел 13 ТЗ).
 */
export class RsmpRowMapper {
  constructor(
    private readonly catalog: Catalog,
    private readonly source: { id: string; url: string; freshDays: number },
    private readonly assessor = new SupplierTypeAssessor(),
  ) {}

  map(batch: Company[], dataDate: string): RsmpRows {
    const { checkedAt, freshUntil } = freshness(dataDate, this.source.freshDays);
    const rows: RsmpRows = { suppliers: [], products: [], facts: [] };

    for (const c of batch) {
      const t = this.assessor.assess(c);
      const address = [c.regionName, c.city && c.city !== c.regionName ? `г. ${c.city}` : null].filter(Boolean).join(', ');
      rows.suppliers.push({
        inn: c.inn,
        ogrn: c.ogrn,
        name: c.name,
        shortName: c.name,
        entityType: c.entityType,
        regionCode: c.regionCode,
        regionName: c.regionName,
        city: c.city,
        address,
        okvedMain: c.okvedMain,
        okvedAdditional: c.okvedAdd,
        smeStatus: c.sme,
        supplierType: t.type,
        supplierTypeConfidence: t.confidence,
        supplierTypeBasis: t.basis,
        checkedAt,
        registrySeenAt: dataDate,
        declaredProducts: c.declared,
      });

      const product = (p: Omit<ByInn<ProductWriteRow>, 'inn' | 'source' | 'sourceUrl' | 'checkedAt'>) =>
        rows.products.push({ ...p, inn: c.inn, source: this.source.id, sourceUrl: this.source.url, checkedAt });
      const withProducts = new Set(c.products.map((p) => p.categoryId));
      const declared = new Set(c.products.map((p) => p.productId));
      for (const p of c.products) {
        product({ categoryId: p.categoryId, productId: p.productId, title: p.title, okpd2: this.catalog.product(p.productId)?.okpd2 ?? null, origin: 'SME_DECLARED' });
      }
      // Товар по основному ОКВЭД: «16.21.11 Производство фанеры» — фанера, а не вся категория «Пиломатериалы»
      for (const p of c.okvedProducts.filter((x) => !declared.has(x.productId))) {
        product({
          categoryId: p.categoryId,
          productId: p.productId,
          title: `Основной вид деятельности: ${c.okvedMain.name}`,
          okpd2: null,
          origin: 'OKVED',
          characteristics: { basis: 'okved', okved: c.okvedMain.code, exact: p.exact },
        });
        withProducts.add(p.categoryId);
      }
      for (const categoryId of c.categories.filter((x) => !withProducts.has(x))) {
        product({ categoryId, productId: null, title: `Основной вид деятельности: ${c.okvedMain.name}`, okpd2: null, origin: 'OKVED' });
      }

      const fact = (field: string, value: string, confidence: number, notes: string | null = null) =>
        rows.facts.push({ inn: c.inn, field, value, notes, source: this.source.id, sourceUrl: this.source.url, checkedAt, freshUntil, confidence });
      fact('legal_status', 'ACTIVE', 0.85, `Компания включена в реестр МСП на ${ruDate(dataDate)}: в реестре только действующие субъекты. Статус в ЕГРЮЛ не проверялся`);
      fact('okved_main', c.okvedMain.code, 0.99);
      fact('okved_additional', c.okvedAdd.map((o) => o.code).join(','), 0.99);
      fact('region', c.regionCode, 0.99);
      fact('sme_status', c.sme, 0.99);
      if (c.includedAt) fact('sme_included_at', c.includedAt, 0.99);
      if (c.employees !== null) fact('employees_count', String(c.employees), 0.95, 'Среднесписочная численность по данным реестра МСП');
      if (c.declared.length) fact('declared_products', c.declared.map((d) => `${d.code} ${d.name}`).join('; '), 0.6, 'Продукция заявлена самой компанией');
      fact('supplier_type', t.type, t.confidence, t.basis);
    }
    return rows;
  }
}
