import type { Catalog } from '../catalog/catalog';
import type { Fact, LegalStatus, Provenance, SearchQuery, SmeStatus } from '../domain/types';
import type { DocumentRow, ProductRow, RiskRow, VerificationRow } from '../sources/types';
import { type AttributeCheck, AttributeMatcher, type EvidenceText } from './attributes';
import { type Coverage, type Evidence, OFFICIAL_ONLY_BY_ACCESS, type ProductMatchLevel, type RegionMatch, type SupplierRow } from './model';
import { TermMatcher } from './terms';

const attributeMatcher = new AttributeMatcher();

export interface DerivedFacts {
  /** detail — уточнение статуса из ЕГРЮЛ (ликвидация, банкротство, реорганизация). */
  legalStatus: Fact<LegalStatus> & { refreshed: boolean; detail?: string | null };
  sme: Fact<SmeStatus> & { refreshed: boolean };
  productMatch: ProductMatchLevel;
  productBasis: ProductBasis;
  /** Чем подтверждён товар: цитата из документа, заявленной продукции или вида деятельности. */
  productEvidence: ProductEvidence | null;
  /** Характеристики запроса, сверенные с документами и сведениями о деятельности. */
  attributeChecks: AttributeCheck[];
  matchedProductTitles: string[];
  /** Источники, не подключённые для этой компании (нет разрешённого доступа). */
  uncovered: string[];
  regionMatch: RegionMatch;
  okvedMatch: boolean;
  gispRecords: ProductRow[];
  pp719Records: ProductRow[];
  documents: DerivedDocument[];
  risks: RiskRow[];
  discrepancies: string[];
  sourcesFailed: string[];
  checkedAt: string;
}

/**
 * Основание совпадения по товару, от сильного к слабому: документ Росаккредитации, в названии продукции которого есть
 * слова запроса, продукция, заявленная в реестре МСП, запись ГИСП или ручной базы, ОКВЭД, называющий сам товар,
 * ОКВЭД группы товаров, документ, лишь привязанный к товару справочника при импорте, слово товара в названии
 * основного вида деятельности, только категория.
 */
export type ProductBasis = 'document' | 'declared' | 'catalog' | 'okved_exact' | 'okved_group' | 'document_linked' | 'okved_text' | 'category';

export interface ProductEvidence {
  quote: string;
  /** В тексте доказательства есть слова запроса («фанера» в названии ОКВЭД или продукции). */
  named?: boolean;
  /** Слово товара в начале названия продукции: документ на сам товар, а не на изделие из него. */
  head?: boolean;
  /** Номер документа или код ОКВЭД. */
  ref: string | null;
  source: EvidenceText['source'];
}

export interface DerivedDocument {
  row: DocumentRow;
  isActive: boolean;
  isOfficiallyVerified: boolean;
  countsAsActive: boolean;
  match: 'product' | 'category' | 'other';
  statusLabel: string;
}

const PSEUDO_SOURCES: Record<string, string> = { MANUAL: 'Ручная тестовая база' };

export function provenanceOf(
  row: Pick<VerificationRow, 'source' | 'source_url' | 'checked_at'> &
    Partial<Pick<VerificationRow, 'source_type' | 'fresh_until' | 'confidence' | 'is_official' | 'is_manual_test_data'>>,
  catalog: Catalog,
  now: Date,
): Provenance {
  const src = catalog.source(row.source);
  const isManual = row.is_manual_test_data ?? true;
  const freshUntil = row.fresh_until ?? null;
  return {
    source: row.source,
    sourceName: PSEUDO_SOURCES[row.source] ?? src.name,
    sourceUrl: row.source_url || src.url || null,
    sourceType: row.source_type ?? (isManual ? 'MANUAL_TEST_DATA' : 'OFFICIAL'),
    checkedAt: row.checked_at,
    freshUntil,
    confidence: row.confidence ?? 0.9,
    isOfficial: row.is_official ?? !isManual,
    isManualTestData: isManual,
    stale: freshUntil ? new Date(freshUntil).getTime() < now.getTime() : false,
  };
}

export function fieldValue(rows: VerificationRow[] | null | undefined, field: string): VerificationRow | undefined {
  return rows?.find((r) => r.field === field);
}

function matchesOkved(code: string | undefined, prefixes: string[]): boolean {
  return !!code && prefixes.some((p) => code === p || code.startsWith(p + '.'));
}

export function regionMatchOf(supplierRegion: string, queryRegion: string | null, catalog: Catalog): RegionMatch {
  if (!queryRegion || queryRegion === 'RU') return 'any';
  if (supplierRegion === queryRegion) return 'same';
  if (catalog.neighbors(queryRegion).includes(supplierRegion)) return 'neighbor';
  return 'other';
}

const DOC_STATUS_LABEL: Record<DocumentRow['status'], string> = {
  ACTIVE: 'Действует',
  SUSPENDED: 'Приостановлен',
  TERMINATED: 'Прекращён',
  ARCHIVED: 'Архивный (срок истёк)',
  UNKNOWN: 'Статус не определён',
};

export function deriveFacts(
  s: SupplierRow,
  ev: Evidence,
  query: SearchQuery | null,
  catalog: Catalog,
  now: Date,
  demoTrustManual: boolean,
  coverage: Coverage = null,
): DerivedFacts {
  const sourcesFailed: string[] = [];
  const today = now.toISOString().slice(0, 10);
  const uncovered = s.source_type === 'OFFICIAL' && coverage ? OFFICIAL_ONLY_BY_ACCESS.filter((src) => !coverage.has(src)) : [];

  // Статус деятельности: ЕГРЮЛ → реестр МСП (в нём только действующие субъекты) → последний известный с отметкой
  const legalRow = fieldValue(ev.fns?.rows, 'legal_status');
  const smeLegalRow = fieldValue(ev.sme, 'legal_status');
  let legalStatus: DerivedFacts['legalStatus'];
  if (legalRow) {
    const state = fieldValue(ev.fns?.rows, 'egrul_state');
    const detail = state && legalRow.value === 'ACTIVE' && state.value !== 'ACTIVE' ? state.notes : null;
    legalStatus = { value: legalRow.value as LegalStatus, provenance: provenanceOf(legalRow, catalog, now), refreshed: true, detail };
  } else if (smeLegalRow && s.legal_status !== 'UNKNOWN') {
    legalStatus = { value: smeLegalRow.value as LegalStatus, provenance: provenanceOf(smeLegalRow, catalog, now), refreshed: true };
  } else if (s.source_type === 'OFFICIAL') {
    legalStatus = {
      value: 'UNKNOWN',
      provenance: smeLegalRow ? { ...provenanceOf(smeLegalRow, catalog, now), stale: true } : null,
      refreshed: false,
    };
  } else {
    if (!ev.fns) sourcesFailed.push('FNS_EGRUL');
    legalStatus = {
      value: s.legal_status,
      provenance: { ...provenanceOf({ source: 'FNS_EGRUL', source_url: null, checked_at: s.checked_at }, catalog, now), stale: true },
      refreshed: false,
    };
  }

  const smeRow = fieldValue(ev.sme, 'sme_status');
  let sme: DerivedFacts['sme'];
  if (smeRow) sme = { value: smeRow.value as SmeStatus, provenance: provenanceOf(smeRow, catalog, now), refreshed: true };
  else {
    if (!ev.sme) sourcesFailed.push('SME_REGISTRY');
    sme = { value: 'UNKNOWN', provenance: null, refreshed: false };
  }

  const category = catalog.category(query?.categoryId ?? null);
  const inCategory = s.products.filter((p) => !category || p.category_id === category.id);
  const terms = query ? TermMatcher.forQuery(query, catalog) : new TermMatcher([]);

  const okvedMain = fieldValue(ev.fns?.rows, 'okved_main')?.value ?? s.okved_main?.code;
  const okvedAdd = (fieldValue(ev.fns?.rows, 'okved_additional')?.value.split(',') ?? s.okved_additional.map((o) => o.code)).filter(Boolean);
  const okvedMatch = category ? [okvedMain, ...okvedAdd].some((c) => matchesOkved(c, category.okved)) : false;

  const inScope = (p: { category_id: string; product_id: string | null }) => !category || p.category_id === category.id;
  if (!ev.gisp) sourcesFailed.push('GISP');
  if (!ev.pp719) sourcesFailed.push('GISP_PP719');
  const gispRecords = (ev.gisp ?? []).filter(inScope);
  const pp719Records = (ev.pp719 ?? []).filter((p) => inScope(p) && p.russian_origin_confirmed);

  if (!ev.certs) sourcesFailed.push('FSA_CERT');
  if (!ev.decls) sourcesFailed.push('FSA_DECL');
  const documents: DerivedDocument[] = [...(ev.decls ?? []), ...(ev.certs ?? [])].map((row) => {
    const notExpired = !row.valid_to || row.valid_to >= today;
    const isActive = row.status === 'ACTIVE' && notExpired;
    const isOfficiallyVerified = isActive && !row.is_manual_test_data;
    const productCategory = catalog.product(row.product_id)?.categoryId;
    // Документ на товар: привязан к нему при импорте или в названии продукции есть слова товара
    const onProduct = query?.productId ? row.product_id === query.productId || !!terms.find(row.product_name) : !!terms.find(row.product_name);
    const match: DerivedDocument['match'] = onProduct
      ? 'product'
      : row.product_id && (!category || productCategory === category.id)
        ? query?.productId
          ? 'category'
          : 'product'
        : 'other';
    let statusLabel = DOC_STATUS_LABEL[row.status];
    if (row.status === 'ACTIVE' && !notExpired) statusLabel = 'Срок действия истёк';
    return { row, isActive, isOfficiallyVerified, countsAsActive: isOfficiallyVerified || (isActive && demoTrustManual), match, statusLabel };
  });

  const product = productFacts(s, query, inCategory, documents, terms);
  const attributeChecks = query?.attributes?.length ? attributeMatcher.check(query.attributes, evidenceTexts(s, documents, product.productMatch === 'product')) : [];

  if (!ev.rnp) sourcesFailed.push('FAS_RNP');
  if (!ev.fedresurs) sourcesFailed.push('FEDRESURS');
  const risks = [...(ev.fns?.risks ?? []), ...(ev.rnp ?? []), ...(ev.fedresurs ?? [])];

  const discrepancies: string[] = [];
  const claim = fieldValue(ev.manual, 'supplier_type_claim');
  if (claim && claim.value !== s.supplier_type) {
    discrepancies.push(claim.notes ?? 'Сведения о типе поставщика в разных источниках расходятся');
  }
  const fnsRegion = fieldValue(ev.fns?.rows, 'region')?.value;
  if (fnsRegion && fnsRegion !== s.region_code) {
    discrepancies.push('Регион в карточке компании отличается от региона регистрации в ЕГРЮЛ');
  }

  const dates = [s.checked_at, legalRow?.checked_at, smeRow?.checked_at].filter(Boolean) as string[];
  const checkedAt = dates.sort().at(-1) ?? s.checked_at;

  return {
    legalStatus,
    sme,
    ...product,
    attributeChecks,
    uncovered,
    regionMatch: regionMatchOf(s.region_code, query?.regionCode ?? null, catalog),
    okvedMatch,
    gispRecords,
    pp719Records,
    documents,
    risks,
    discrepancies,
    sourcesFailed: [...new Set(sourcesFailed)],
    checkedAt,
  };
}

/** Тексты, в которых проверяются характеристики: документы о товаре — первыми. */
function evidenceTexts(s: SupplierRow, documents: DerivedDocument[], productMatched: boolean): EvidenceText[] {
  const out: EvidenceText[] = documents
    .filter((d) => d.row.product_name)
    .map((d) => ({ text: d.row.product_name!, source: 'document' as const, ref: d.row.number, relevant: d.match === 'product' }));
  for (const p of s.products.filter((x) => x.origin !== 'OKVED')) out.push({ text: p.title, source: 'declared', ref: p.product_id ?? '', relevant: productMatched });
  if (s.okved_main?.name) out.push({ text: s.okved_main.name, source: 'okved', ref: s.okved_main.code, relevant: false });
  return out;
}

/** Совпадение по товару и его основание — от документа на товар до одной категории. */
function productFacts(
  s: SupplierRow,
  query: SearchQuery | null,
  inCategory: SupplierRow['products'],
  documents: DerivedDocument[],
  terms: TermMatcher,
): Pick<DerivedFacts, 'productMatch' | 'productBasis' | 'productEvidence' | 'matchedProductTitles'> {
  const productId = query?.productId ?? null;
  const onProduct = documents.filter((d) => d.match === 'product' && (productId || !terms.empty));
  const named = onProduct.map((d) => ({ d, hit: terms.find(d.row.product_name) })).filter((x) => x.hit);
  // Документ на сам товар («Фанера…») сильнее документа на изделие из него («Панели… из фанеры»), действующий — сильнее
  const rank = (x: (typeof named)[number]) => Number(x.hit!.head) * 2 + Number(x.d.countsAsActive);
  const best = [...named].sort((a, b) => rank(b) - rank(a))[0];
  const doc = best?.d;
  const linked = onProduct.find((d) => d.countsAsActive) ?? onProduct[0];
  const records = productId ? s.products.filter((p) => p.product_id === productId) : [];
  const titles = (list: SupplierRow['products']) => list.map((p) => p.title);
  const okved = s.okved_main;

  if (doc && (productId || !terms.empty)) {
    const kind = doc.row.document_type === 'DECLARATION' ? 'декларация' : 'сертификат';
    const quote = best!.hit!.quote;
    return {
      productMatch: 'product',
      productBasis: 'document',
      productEvidence: { quote, ref: `${kind} ${doc.row.number}`, source: 'document', named: true, head: best!.hit!.head },
      matchedProductTitles: [doc.row.product_name ?? ''],
    };
  }
  const declared = records.find((p) => p.origin === 'SME_DECLARED');
  if (declared) return { productMatch: 'product', productBasis: 'declared', productEvidence: { quote: declared.title, ref: null, source: 'declared' }, matchedProductTitles: titles(records) };
  const catalogRecord = records.find((p) => p.origin === 'GISP' || p.origin === 'MANUAL_TEST_DATA');
  if (catalogRecord) return { productMatch: 'product', productBasis: 'catalog', productEvidence: null, matchedProductTitles: titles(records) };
  const byOkved = records.find((p) => p.origin === 'OKVED');
  if (byOkved && okved) {
    return {
      productMatch: 'product',
      productBasis: byOkved.characteristics?.exact ? 'okved_exact' : 'okved_group',
      productEvidence: { quote: okved.name, ref: okved.code, source: 'okved', named: !!terms.find(okved.name) },
      matchedProductTitles: titles(records),
    };
  }
  if (linked && productId) {
    const kind = linked.row.document_type === 'DECLARATION' ? 'декларация' : 'сертификат';
    return {
      productMatch: 'product',
      productBasis: 'document_linked',
      productEvidence: { quote: (linked.row.product_name ?? '').slice(0, 160), ref: `${kind} ${linked.row.number}`, source: 'document' },
      matchedProductTitles: [linked.row.product_name ?? ''],
    };
  }
  const text = productId && okved ? terms.find(okved.name) : null;
  if (text && okved && inCategory.length) return { productMatch: 'product', productBasis: 'okved_text', productEvidence: { quote: okved.name, ref: okved.code, source: 'okved' }, matchedProductTitles: titles(inCategory) };
  if (inCategory.length) return { productMatch: 'category', productBasis: 'category', productEvidence: null, matchedProductTitles: titles(inCategory) };
  return { productMatch: 'none', productBasis: 'category', productEvidence: null, matchedProductTitles: [] };
}
