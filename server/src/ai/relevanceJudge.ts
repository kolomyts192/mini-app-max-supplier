import crypto from 'node:crypto';
import { z } from 'zod';
import type { Catalog } from '../catalog/catalog';
import type { SearchQuery } from '../domain/types';
import type { RedisClient } from '../infra/redis';
import type { Logger } from '../logger';
import { attributeLabel } from '../search/attributes';
import type { AiStepStatus, SupplierSummary } from '../search/dto';
import type { SupplierRow } from '../search/model';
import { type LlmClient, type LlmFunction, LlmUnavailableError } from './llm';

/** Оценка ИИ: 3 — сведения прямо подтверждают товар, 2 — производит товар, 1 — смежное, 0 — не подходит. */
export interface RelevanceVerdict {
  relevance: 0 | 1 | 2 | 3;
  reason: string;
  /** Дословная цитата из сведений кандидата, проверенная программно. */
  quote: string;
}

export interface JudgeResult {
  verdicts: Map<string, RelevanceVerdict>;
  status: AiStepStatus;
}

/** Оценка кандидатов выдачи по доказательствам из реестров. */
export interface RelevanceJudge {
  readonly enabled: boolean;
  judge(q: SearchQuery, candidates: { summary: SupplierSummary; row: SupplierRow }[]): Promise<JudgeResult>;
}

/** Обезличенные сведения кандидата: что о его продукции говорят реестры. Название, ИНН и ФИО не передаются. */
export interface EvidencePack {
  key: string;
  supplierId: string;
  lines: string[];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Сведения о продукции кандидата — то же, на чём основано объяснение выдачи. */
export class EvidencePackBuilder {
  build(key: string, summary: SupplierSummary, row: SupplierRow): EvidencePack {
    const lines: string[] = [];
    if (row.okved_main) lines.push(`ОКВЭД: ${row.okved_main.code} ${row.okved_main.name}`);
    const declared = row.products.filter((p) => p.origin === 'SME_DECLARED').map((p) => p.title);
    if (declared.length) lines.push(`Заявленная продукция: ${clip([...new Set(declared)].join('; '), 200)}`);
    const docs = [...summary.documents.items].sort((a, b) => Number(b.match === 'product') - Number(a.match === 'product')).filter((d) => d.productName).slice(0, 2);
    for (const d of docs) lines.push(`${d.type === 'DECLARATION' ? 'Декларация' : 'Сертификат'} (${d.statusLabel.toLowerCase()}): ${clip(d.productName!, 180)}`);
    for (const a of summary.match.attributes) {
      const state = a.status === 'confirmed' ? 'подтверждено' : a.status === 'mismatch' ? 'в документе другое значение' : 'не указано';
      lines.push(`Характеристика «${a.label}»: ${state}${a.quote ? ` — ${clip(a.quote, 80)}` : ''}`);
    }
    return { key, supplierId: summary.id, lines };
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'`]/g, '')
    .replace(/[…]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Цитата из объяснения ИИ должна дословно (с точностью до регистра и пробелов) быть в сведениях кандидата. */
export class CitationVerifier {
  verify(quote: string, pack: EvidencePack): boolean {
    const q = norm(quote);
    return q.length >= 5 && norm(pack.lines.join(' ')).includes(q);
  }
}

const argsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        relevance: z.coerce.number().int().min(0).max(3),
        reason: z.string().default(''),
        quote: z.string().default(''),
      }),
    )
    .default([]),
});

const SYSTEM = `Ты оцениваешь, насколько поставщики подходят под запрос закупщика, только по приведённым сведениям из официальных реестров: ОКВЭД, заявленная продукция, названия продукции в сертификатах и декларациях. Не используй другие знания о компаниях и ничего не додумывай.
relevance: 3 — сведения прямо подтверждают нужный товар (и характеристики, если они указаны в запросе); 2 — компания производит этот товар, но характеристики не подтверждены; 1 — смежная продукция или только общий вид деятельности; 0 — не подходит.
reason — одно короткое предложение (до 120 символов), почему такая оценка.
quote — дословная цитата из сведений этого кандидата (от 5 до 100 символов), на которой основана оценка.
Оцени каждого кандидата ровно один раз.`;

/**
 * Оценка кандидатов GigaChat. Модель видит только обезличенные сведения о продукции под номерами c1…cN;
 * оценка учитывается, только если её цитата найдена в сведениях именно этого кандидата.
 */
export class GigaChatRelevanceJudge implements RelevanceJudge {
  private readonly packs = new EvidencePackBuilder();
  private readonly citations = new CitationVerifier();

  constructor(
    private readonly llm: LlmClient,
    private readonly catalog: Catalog,
    private readonly cache: RankingCache,
    private readonly log: Logger,
    private readonly opts: { deadlineMs: number; top: number },
  ) {}

  get enabled(): boolean {
    return this.llm.enabled && this.opts.top > 1;
  }

  async judge(q: SearchQuery, candidates: { summary: SupplierSummary; row: SupplierRow }[]): Promise<JudgeResult> {
    if (!this.enabled) return { verdicts: new Map(), status: 'disabled' };
    const packs = candidates.slice(0, this.opts.top).map((c, i) => this.packs.build(`c${i + 1}`, c.summary, c.row));
    if (packs.length < 2) return { verdicts: new Map(), status: 'skipped' };
    const queryText = this.describe(q);
    const cacheKey = RankingCache.key(queryText, packs);
    const cached = await this.cache.get(cacheKey);
    if (cached) return { verdicts: cached, status: 'cached' };
    try {
      const result = await this.llm.callFunction({
        purpose: 'rank',
        system: SYSTEM,
        user: `${queryText}\n\nКандидаты:\n${packs.map((p) => `[${p.key}]\n${p.lines.join('\n')}`).join('\n\n')}`,
        fn: this.fn(packs.map((p) => p.key)),
        deadlineMs: this.opts.deadlineMs,
        maxTokens: 60 * packs.length + 100,
      });
      const parsed = argsSchema.safeParse(result.args);
      if (!parsed.success) throw new LlmUnavailableError('invalid', 'оценка GigaChat не по схеме');
      const verdicts = this.verified(parsed.data.items, packs);
      await this.cache.set(cacheKey, verdicts);
      return { verdicts, status: 'ok' };
    } catch (err) {
      const reason = err instanceof LlmUnavailableError ? err.reason : 'unavailable';
      this.log.warn({ reason, err: (err as Error).message }, 'ranking fell back to rules');
      return { verdicts: new Map(), status: reason === 'timeout' || reason === 'busy' ? 'timeout' : 'error' };
    }
  }

  /** Только оценки с подтверждённой цитатой; остальные кандидаты остаются в порядке без ИИ. */
  private verified(items: z.infer<typeof argsSchema>['items'], packs: EvidencePack[]): Map<string, RelevanceVerdict> {
    const byKey = new Map(packs.map((p) => [p.key, p]));
    const out = new Map<string, RelevanceVerdict>();
    let rejected = 0;
    for (const item of items) {
      const pack = byKey.get(item.id);
      if (!pack || out.has(pack.supplierId)) continue;
      if (!this.citations.verify(item.quote, pack) || !item.reason.trim()) {
        rejected += 1;
        continue;
      }
      out.set(pack.supplierId, { relevance: item.relevance as RelevanceVerdict['relevance'], reason: clip(item.reason.trim(), 160), quote: clip(item.quote.trim(), 120) });
    }
    if (rejected) this.log.info({ rejected, accepted: out.size }, 'ranking verdicts without verifiable quote dropped');
    return out;
  }

  private describe(q: SearchQuery): string {
    const product = this.catalog.product(q.productId)?.name ?? this.catalog.category(q.categoryId)?.name ?? q.text;
    const attrs = (q.attributes ?? []).map(attributeLabel);
    return [`Запрос: «${clip(q.text || product, 120)}»`, `Товар: ${product}`, attrs.length ? `Характеристики: ${attrs.join(', ')}` : null].filter(Boolean).join('\n');
  }

  private fn(keys: string[]): LlmFunction {
    return {
      name: 'rank_candidates',
      description: 'Оценки соответствия кандидатов запросу закупщика',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', enum: keys },
                relevance: { type: 'integer', enum: [0, 1, 2, 3], description: '3 — подтверждено, 2 — производит товар, 1 — смежное, 0 — не подходит' },
                reason: { type: 'string', description: 'Почему такая оценка, до 120 символов' },
                quote: { type: 'string', description: 'Дословная цитата из сведений кандидата' },
              },
              required: ['id', 'relevance', 'reason', 'quote'],
            },
          },
        },
        required: ['items'],
      },
    };
  }
}

/** Кэш оценок в Redis на час: тот же запрос и те же кандидаты не тратят токены повторно. */
export class RankingCache {
  private static readonly TTL_SEC = 3600;

  constructor(private readonly redis: RedisClient) {}

  static key(query: string, packs: EvidencePack[]): string {
    const hash = crypto.createHash('sha1').update(query).update(packs.map((p) => `${p.supplierId}:${p.lines.join('|')}`).join('\n')).digest('hex');
    return `ai:rank:v1:${hash}`;
  }

  async get(key: string): Promise<Map<string, RelevanceVerdict> | null> {
    const raw = await this.redis.get(key).catch(() => null);
    return raw ? new Map(Object.entries(JSON.parse(raw) as Record<string, RelevanceVerdict>)) : null;
  }

  async set(key: string, verdicts: Map<string, RelevanceVerdict>): Promise<void> {
    await this.redis.set(key, JSON.stringify(Object.fromEntries(verdicts)), 'EX', RankingCache.TTL_SEC).catch(() => undefined);
  }
}

/** Без ключа GigaChat: порядок выдачи — по формуле ТЗ. */
export class DisabledRelevanceJudge implements RelevanceJudge {
  readonly enabled = false;

  async judge(): Promise<JudgeResult> {
    return { verdicts: new Map(), status: 'disabled' };
  }
}
