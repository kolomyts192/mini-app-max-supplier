import type { Catalog } from '../catalog/catalog';
import { normalize, tokenize } from '../catalog/text';
import type { Attribute, SearchQuery } from '../domain/types';
import { type ParsedQuery, parseQuery } from '../parser/queryParser';
import { AttributeExtractor } from './attributes';

/** Как разобран запрос и что с ИИ: ok — разобран ИИ, cached — из кэша, остальное — разбор только на правилах. */
export type InterpretationStatus = 'ok' | 'cached' | 'disabled' | 'timeout' | 'error' | 'skipped';

/** Разобранный свободный текст: параметры поиска, характеристики товара и уточняющий вопрос. */
export interface Interpretation extends Omit<ParsedQuery, 'missing'> {
  attributes: Attribute[];
  /** Слова для поиска по названиям продукции в документах: «фанера», «ФСФ», «берёзовая». */
  terms: string[];
  /** Вопрос о характеристиках, если без них подбор будет слишком широким («Какая толщина и марка фанеры?»). */
  clarify: string | null;
  source: 'rules' | 'ai';
  status: InterpretationStatus;
}

/** Разбор свободного запроса закупщика. */
export interface QueryInterpreter {
  interpret(text: string): Promise<Interpretation>;
}

/** Разбор на правилах: справочник синонимов, регионы, объём, тип поставщика, характеристики. Работает всегда. */
export class RuleQueryInterpreter implements QueryInterpreter {
  constructor(
    private readonly catalog: Catalog,
    private readonly extractor = new AttributeExtractor(),
  ) {}

  async interpret(text: string): Promise<Interpretation> {
    return this.interpretSync(text);
  }

  /** Правила справились сами: узнан конкретный товар справочника, ИИ для разбора не нужен. */
  static confident(i: Interpretation): boolean {
    return !!i.product?.productId && i.product.confidence >= 0.8;
  }

  interpretSync(text: string): Interpretation {
    const { missing: _missing, ...parsed } = parseQuery(text, this.catalog);
    return { ...parsed, attributes: this.attributes(text, parsed.product), terms: [], clarify: null, source: 'rules', status: 'disabled' };
  }

  /** Слова товара («ОСБ», «ПВХ», «ВВГ») — это сам товар, а не его марка. */
  attributes(text: string, product: ParsedQuery['product']): Attribute[] {
    const words = new Set<string>();
    const p = this.catalog.product(product?.productId);
    const c = this.catalog.category(product?.categoryId);
    for (const s of [...(p ? [p.name, ...p.synonyms] : []), ...(c?.synonyms ?? [])]) for (const t of tokenize(s)) words.add(t);
    return this.extractor.fromQuery(text, (t) => words.has(normalize(t)));
  }
}

/**
 * Дополняет поисковый запрос разобранным текстом, не перетирая то, что пользователь выбрал явно
 * (товар из подсказки, регион и фильтры мини-приложения).
 */
export function applyInterpretation(q: SearchQuery, i: Interpretation): SearchQuery {
  const out: SearchQuery = { ...q, interpreted: true };
  if (!out.productId && !out.categoryId && i.product && i.product.confidence >= 0.6) {
    out.productId = i.product.productId;
    out.categoryId = i.product.categoryId;
  }
  if (!out.regionCode && i.region) out.regionCode = i.region.code;
  if (!out.volume && i.volume) out.volume = i.volume;
  if (out.supplierType === 'ANY' && i.supplierType && i.supplierTypeConfidence >= 0.8) out.supplierType = i.supplierType;
  if (out.certificate === 'PREFERRED' && i.certificate) out.certificate = i.certificate;
  if (!out.attributes?.length) out.attributes = i.attributes;
  out.terms = [...new Set([...(out.terms ?? []), ...i.terms])].slice(0, 8);
  return out;
}
