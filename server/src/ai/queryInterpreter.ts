import crypto from 'node:crypto';
import { z } from 'zod';
import type { Catalog } from '../catalog/catalog';
import { normalize, stem, tokenize } from '../catalog/text';
import type { Attribute } from '../domain/types';
import type { RedisClient } from '../infra/redis';
import type { Logger } from '../logger';
import { matchRegion, type ProductMatch } from '../parser/queryParser';
import { attributeLabel } from '../search/attributes';
import type { Interpretation, QueryInterpreter, RuleQueryInterpreter } from '../search/interpretation';
import { type LlmClient, type LlmFunction, LlmUnavailableError } from './llm';

/** Ответ модели по схеме функции extract_purchase_query. */
const argsSchema = z.object({
  product_id: z.string().default('none'),
  category_id: z.string().default('none'),
  product_confidence: z.coerce.number().min(0).max(1).catch(0.5),
  region: z.string().default(''),
  attributes: z
    .array(
      z.object({
        name: z.string().default(''),
        value: z.coerce.number().nullable().optional().catch(null),
        values: z.array(z.coerce.number()).optional().catch([]),
        unit: z.string().nullable().optional().catch(null),
        text: z.string().nullable().optional().catch(null),
      }),
    )
    .catch([]),
  volume: z.object({ value: z.coerce.number(), unit: z.string(), operator: z.enum(['lte', 'gte', 'eq']).catch('eq') }).nullable().optional().catch(null),
  supplier_type: z.string().default('unknown'),
  documents_required: z.boolean().optional().catch(undefined),
  terms: z.array(z.string()).catch([]),
  clarify: z.string().default(''),
});
type Args = z.infer<typeof argsSchema>;

/** Только то, что модель добавила к правилам: товар, регион, характеристики, термины и вопрос. */
export type AiInterpretation = Pick<Interpretation, 'product' | 'region' | 'volume' | 'supplierType' | 'supplierTypeConfidence' | 'certificate' | 'attributes' | 'terms' | 'clarify'>;

const SYSTEM = `Ты разбираешь запрос закупщика в сервисе поиска поставщиков в России и возвращаешь параметры только через функцию extract_purchase_query.
Правила:
1. Товар выбирай только из справочника ниже (product_id). Если подходит лишь категория — укажи category_id, а product_id = none. Если ничего не подходит — оба none.
2. Характеристики (attributes) — только явно названные в запросе: размеры (толщина, диаметр, сечение, ширина, длина), марка или класс (ФСФ, М300, А500С, ПФ-115), сорт, стандарт (ГОСТ), материал. Ничего не придумывай и не дополняй.
3. Объём партии (тонны, кубометры, штуки, литры) — в volume, а не в характеристики.
4. region — город или регион ровно как в запросе; пустая строка, если не указан.
5. terms — 2–6 слов и коротких фраз, которыми этот товар называют в сертификатах и декларациях: основное название и его разновидности. Без регионов и чисел.
6. clarify — один короткий вопрос о характеристиках, только если без них подбор слишком широкий (например, «фанера» без толщины и марки); иначе пустая строка.
7. supplier_type: «только производитель», «напрямую с завода» — MANUFACTURER_ONLY; «производитель или дилер» — MANUFACTURER_OR_DISTRIBUTOR; «любой поставщик» — ANY; иначе unknown.
8. documents_required = true, только если просят сертификат, декларацию или документы.`;

/**
 * Разбор запроса GigaChat. Товар, категория и единицы объёма — только из перечней справочника,
 * регион сопоставляется со справочником правилами, а характеристика принимается, только если её число
 * или слово действительно есть в тексте запроса: модель не может добавить то, чего пользователь не писал.
 */
export class GigaChatQueryInterpreter {
  private readonly fn: LlmFunction;
  private readonly catalogText: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly catalog: Catalog,
  ) {
    const products = catalog.data.categories.flatMap((c) => c.products.map((p) => p.id));
    const categories = catalog.data.categories.map((c) => c.id);
    this.catalogText = catalog.data.categories
      .map((c) => `${c.id} — ${c.name}: ${c.products.map((p) => `${p.id} (${p.name.toLowerCase()})`).join(', ')}`)
      .join('\n');
    this.fn = {
      name: 'extract_purchase_query',
      description: 'Параметры поиска поставщика, извлечённые из запроса закупщика',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', enum: [...products, 'none'], description: 'Товар из справочника; none — нет подходящего товара' },
          category_id: { type: 'string', enum: [...categories, 'none'], description: 'Категория товара из справочника' },
          product_confidence: { type: 'number', description: 'Уверенность в выборе товара от 0 до 1' },
          region: { type: 'string', description: 'Город или регион из запроса; пустая строка — не указан' },
          attributes: {
            type: 'array',
            description: 'Характеристики товара, явно названные в запросе',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Что это: толщина, диаметр, сечение, размер, марка, сорт, стандарт, материал' },
                value: { type: 'number', description: 'Число, если характеристика числовая: «18 мм» → 18' },
                values: { type: 'array', items: { type: 'number' }, description: 'Размеры через «х»: «150х150» → [150, 150]' },
                unit: { type: 'string', description: 'Единица: мм, см, м, мкм, %' },
                text: { type: 'string', description: 'Текстовое значение: ФСФ, М300, высший, ГОСТ 3916.1-2018' },
              },
              required: ['name'],
            },
          },
          volume: {
            type: 'object',
            description: 'Объём партии, если указан',
            properties: {
              value: { type: 'number' },
              unit: { type: 'string', enum: catalog.data.units.map((u) => u.id) },
              operator: { type: 'string', enum: ['lte', 'gte', 'eq'], description: 'lte — «до», gte — «от», eq — ровно' },
            },
          },
          supplier_type: { type: 'string', enum: ['MANUFACTURER_ONLY', 'MANUFACTURER_OR_DISTRIBUTOR', 'ANY', 'unknown'] },
          documents_required: { type: 'boolean', description: 'Нужны ли сертификаты или декларации' },
          terms: { type: 'array', items: { type: 'string' }, description: 'Как товар называют в документах о соответствии' },
          clarify: { type: 'string', description: 'Вопрос о характеристиках или пустая строка' },
        },
        required: ['product_id', 'category_id', 'product_confidence', 'region', 'attributes', 'terms', 'clarify'],
      },
      examples: [
        {
          request: 'фанера ФСФ 18 мм для опалубки, Москва',
          params: {
            product_id: 'plywood', category_id: 'lumber', product_confidence: 0.95, region: 'Москва',
            attributes: [{ name: 'толщина', value: 18, unit: 'мм' }, { name: 'марка', text: 'ФСФ' }],
            supplier_type: 'unknown', terms: ['фанера', 'фанера ФСФ', 'фанера березовая', 'фанера ламинированная'], clarify: '',
          },
        },
        {
          request: 'нужна фанера',
          params: { product_id: 'plywood', category_id: 'lumber', product_confidence: 0.9, region: '', attributes: [], supplier_type: 'unknown', terms: ['фанера'], clarify: 'Какая толщина и марка фанеры нужны? Например: 18 мм, ФСФ.' },
        },
        {
          request: 'кабель ВВГнг 3х2,5 только от производителя, документы обязательны',
          params: {
            product_id: 'cable', category_id: 'electrical', product_confidence: 0.95, region: '',
            attributes: [{ name: 'марка', text: 'ВВГнг' }, { name: 'сечение', text: '3х2,5' }],
            supplier_type: 'MANUFACTURER_ONLY', documents_required: true, terms: ['кабель', 'кабель силовой', 'кабель ВВГнг'], clarify: '',
          },
        },
      ],
    };
  }

  get enabled(): boolean {
    return this.llm.enabled;
  }

  async interpret(text: string, deadlineMs: number): Promise<AiInterpretation> {
    const result = await this.llm.callFunction({
      purpose: 'interpret',
      system: `${SYSTEM}\n\nСправочник (категория — название: товары):\n${this.catalogText}`,
      user: text.slice(0, 300),
      fn: this.fn,
      deadlineMs,
      maxTokens: 400,
    });
    const parsed = argsSchema.safeParse(result.args);
    if (!parsed.success) throw new LlmUnavailableError('invalid', `ответ GigaChat не по схеме: ${parsed.error.issues[0]?.message}`);
    return this.toInterpretation(parsed.data, text);
  }

  private toInterpretation(a: Args, text: string): AiInterpretation {
    const supplierType = ['MANUFACTURER_ONLY', 'MANUFACTURER_OR_DISTRIBUTOR', 'ANY'].includes(a.supplier_type) ? (a.supplier_type as AiInterpretation['supplierType']) : null;
    const unit = a.volume ? this.catalog.unit(a.volume.unit) : undefined;
    const clarify = a.clarify.trim();
    return {
      product: this.product(a),
      region: a.region.trim() ? matchRegion(a.region, this.catalog) : null,
      volume: a.volume && unit && Number.isFinite(a.volume.value) && a.volume.value > 0 ? { value: a.volume.value, unit: unit.id, operator: a.volume.operator } : null,
      supplierType,
      supplierTypeConfidence: supplierType ? 0.9 : 0,
      certificate: a.documents_required ? 'REQUIRED' : null,
      attributes: this.groundedAttributes(a.attributes, text),
      terms: [...new Set(a.terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 40 && !/\d/.test(t)))].slice(0, 6),
      clarify: clarify && clarify.length <= 200 && clarify.includes('?') ? clarify : null,
    };
  }

  private product(a: Args): ProductMatch | null {
    const p = this.catalog.product(a.product_id);
    if (p) return { productId: p.id, categoryId: p.categoryId, name: p.name, normalized: p.normalized, raw: '', confidence: a.product_confidence };
    const c = this.catalog.category(a.category_id);
    return c ? { productId: null, categoryId: c.id, name: c.name, normalized: c.name, raw: '', confidence: Math.min(a.product_confidence, 0.85) } : null;
  }

  /** Характеристика принимается, только если её число или слово есть в тексте запроса. */
  private groundedAttributes(list: Args['attributes'], text: string): Attribute[] {
    const numbers = new Set((text.replace(/(\d),(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
    const words = new Set(tokenize(text).map(stem));
    const compact = normalize(text).replace(/\s+/g, '');
    const out: Attribute[] = [];
    for (const a of list) {
      const name = normalize(a.name).slice(0, 40);
      const value = typeof a.value === 'number' && Number.isFinite(a.value) ? a.value : null;
      const values = (a.values ?? []).filter((v) => Number.isFinite(v)).slice(0, 4);
      const attrText = a.text?.trim() ? a.text.trim().slice(0, 60) : null;
      if (!name || (value === null && !values.length && !attrText)) continue;
      const grounded =
        (value === null || numbers.has(value)) &&
        values.every((v) => numbers.has(v)) &&
        (!attrText || tokenize(attrText).every((t) => words.has(stem(t)) || compact.includes(t.replace(/\s+/g, ''))));
      if (!grounded) continue;
      out.push({ name, value, values, unit: a.unit?.trim().toLowerCase().slice(0, 10) || null, text: attrText });
    }
    return out.slice(0, 6);
  }
}

/** Кэш разбора в Redis: одинаковый запрос не тратит токены повторно. */
export class InterpretationCache {
  private static readonly TTL_SEC = 24 * 3600;

  constructor(private readonly redis: RedisClient) {}

  private key(text: string): string {
    return `ai:interpret:v1:${crypto.createHash('sha1').update(normalize(text)).digest('hex')}`;
  }

  async get(text: string): Promise<AiInterpretation | null> {
    const raw = await this.redis.get(this.key(text)).catch(() => null);
    return raw ? (JSON.parse(raw) as AiInterpretation) : null;
  }

  async set(text: string, value: AiInterpretation): Promise<void> {
    await this.redis.set(this.key(text), JSON.stringify(value), 'EX', InterpretationCache.TTL_SEC).catch(() => undefined);
  }
}

const attrKey = (a: Attribute) => (a.text ? normalize(a.text) : [a.value, ...a.values].join('x'));

/**
 * Разбор с ИИ и откатом на правила. Правила дают точное: регион, объём, явный тип поставщика;
 * ИИ — смысл: товар, характеристики с правильными названиями, слова для документов и уточняющий вопрос.
 * Ошибка, таймаут или занятость модели не ломают разбор — остаётся результат правил.
 */
export class CombinedQueryInterpreter implements QueryInterpreter {
  constructor(
    private readonly rules: RuleQueryInterpreter,
    private readonly ai: GigaChatQueryInterpreter,
    private readonly cache: InterpretationCache,
    private readonly log: Logger,
    private readonly deadlineMs: number,
  ) {}

  async interpret(text: string): Promise<Interpretation> {
    const base = this.rules.interpretSync(text);
    if (!this.ai.enabled) return base;
    const cached = await this.cache.get(text);
    if (cached) return this.merge(base, cached, 'cached');
    try {
      const ai = await this.ai.interpret(text, this.deadlineMs);
      await this.cache.set(text, ai);
      return this.merge(base, ai, 'ok');
    } catch (err) {
      const reason = err instanceof LlmUnavailableError ? err.reason : 'unavailable';
      this.log.warn({ reason, err: (err as Error).message }, 'query interpretation fell back to rules');
      return { ...base, status: reason === 'timeout' || reason === 'busy' ? 'timeout' : reason === 'disabled' ? 'disabled' : 'error' };
    }
  }

  merge(rules: Interpretation, ai: AiInterpretation, status: Interpretation['status']): Interpretation {
    const product = ai.product && ai.product.confidence >= 0.75 ? { ...ai.product, raw: rules.product?.raw ?? '' } : rules.product ?? ai.product;
    // Одинаковое значение у правил и ИИ — оставляем подпись ИИ («толщина 18 мм» вместо «18 мм»)
    const attributes = [...ai.attributes];
    for (const r of rules.attributes) if (!attributes.some((a) => attrKey(a) === attrKey(r))) attributes.push(r);
    const ruleTypeSure = rules.supplierType && rules.supplierTypeConfidence >= 0.8;
    return {
      ...rules,
      product,
      productCandidates: product && !rules.productCandidates.some((c) => c.productId === product.productId) ? [product, ...rules.productCandidates] : rules.productCandidates,
      region: rules.region ?? ai.region,
      volume: rules.volume ?? ai.volume,
      supplierType: ruleTypeSure ? rules.supplierType : ai.supplierType ?? rules.supplierType,
      supplierTypeConfidence: ruleTypeSure ? rules.supplierTypeConfidence : ai.supplierType ? ai.supplierTypeConfidence : rules.supplierTypeConfidence,
      certificate: rules.certificate ?? ai.certificate,
      attributes: attributes.slice(0, 6),
      terms: ai.terms,
      clarify: attributes.length ? null : ai.clarify,
      source: 'ai',
      status,
    };
  }
}

/** Подпись разбора для логов и отчётов: «plywood · 77 · толщина 18 мм, марка ФСФ». */
export const describeInterpretation = (i: Interpretation) =>
  [i.product?.productId ?? i.product?.categoryId ?? '—', i.region?.code, i.attributes.map(attributeLabel).join(', ')].filter(Boolean).join(' · ');
