import crypto from 'node:crypto';
import { z } from 'zod';
import type { Catalog } from '../catalog/catalog';
import type { SearchQuery } from '../domain/types';
import type { RedisClient } from '../infra/redis';
import type { Logger } from '../logger';
import type { AiStepStatus, SupplierSummary } from '../search/dto';
import type { SupplierRow } from '../search/model';
import { type LlmClient, type LlmFunction, LlmUnavailableError } from './llm';

/** Оценка ИИ: 3 — сам товар по документу, 2 — сам товар только по ОКВЭД, 1 — изделия из товара или смежное, 0 — не подходит. */
export interface RelevanceVerdict {
  relevance: 0 | 1 | 2 | 3;
  reason: string;
  /** Строка сведений из реестров, на которую сослалась модель: текст и откуда он. */
  quote: string;
  source: string;
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

/** Строка сведений: откуда (ОКВЭД, декларация…) и что в ней написано. */
export interface EvidenceLine {
  source: string;
  text: string;
}

/**
 * Обезличенные сведения кандидата: что о его продукции говорят реестры. Название, ИНН и ФИО не передаются.
 * Характеристики сюда не входят: их сверяют правила, а модель судит только о том, тот ли это товар.
 */
export interface EvidencePack {
  key: string;
  supplierId: string;
  lines: EvidenceLine[];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Сведения о продукции кандидата — то же, на чём основано объяснение выдачи. */
export class EvidencePackBuilder {
  build(key: string, summary: SupplierSummary, row: SupplierRow): EvidencePack {
    const lines: EvidenceLine[] = [];
    if (row.okved_main) lines.push({ source: 'ОКВЭД', text: `${row.okved_main.code} ${row.okved_main.name}` });
    const declared = row.products.filter((p) => p.origin === 'SME_DECLARED').map((p) => p.title);
    if (declared.length) lines.push({ source: 'Заявленная продукция', text: clip([...new Set(declared)].join('; '), 200) });
    const docs = [...summary.documents.items].sort((a, b) => Number(b.match === 'product') - Number(a.match === 'product')).filter((d) => d.productName).slice(0, 2);
    for (const d of docs) lines.push({ source: `${d.type === 'DECLARATION' ? 'Декларация' : 'Сертификат'} (${d.statusLabel.toLowerCase()})`, text: clip(d.productName!, 180) });
    return { key, supplierId: summary.id, lines };
  }

  /** Сведения для модели. У строк сквозные номера (c3.2), чтобы оценка ссылалась на строку однозначно. */
  static render(pack: EvidencePack): string {
    return pack.lines.map((l, i) => `${pack.key}.${i + 1} ${l.source}: ${l.text}`).join('\n');
  }

  /** Строка, на которую сослалась модель, — только из сведений этого кандидата. */
  static line(pack: EvidencePack, ref: string): EvidenceLine | null {
    const m = new RegExp(`^${pack.key}\\.(\\d+)$`).exec(ref.trim());
    return m ? (pack.lines[Number(m[1]) - 1] ?? null) : null;
  }
}

const argsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        relevance: z.coerce.number().int().min(0).max(3),
        basis: z.coerce.string().catch(''),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

const SYSTEM = `Ты проверяешь, поставляет ли кандидат именно нужный товар, только по приведённым сведениям из официальных реестров: ОКВЭД, заявленная продукция, продукция в сертификатах и декларациях. Не используй другие знания о компаниях и ничего не додумывай.
Марку, размеры, сорт, класс и назначение не оценивай: их сверяет программа отдельно, поэтому в запросе их нет.
Если запрос уточняет, из чего товар (пшеничная мука, березовая фанера), продукция из другого сырья — 1.
relevance:
3 — документ или заявленная продукция на сам товар;
2 — сам товар следует только из ОКВЭД;
1 — изделия из этого товара или смежная продукция (для товара «фанера» — панели на основе фанеры, отделочные системы);
0 — сведения не относятся к товару.
basis — номер строки сведений, на которой основана оценка, например c3.2.
reason — коротко, до 60 символов: что это за продукция.
Оцени каждого кандидата ровно один раз.`;

/**
 * Оценка кандидатов GigaChat. Модель видит только обезличенные сведения о продукции под номерами c1…cN
 * с пронумерованными строками; оценка учитывается, только если ссылается на существующую строку сведений
 * именно этого кандидата — эта строка и показывается как основание. Ссылка вместо цитаты: модель не может
 * исказить текст реестра, а ответ короче и быстрее.
 */
export class GigaChatRelevanceJudge implements RelevanceJudge {
  private readonly packs = new EvidencePackBuilder();

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
    const packs = candidates.slice(0, this.opts.top).map((c, i) => this.packs.build(`c${i + 1}`, c.summary, c.row)).filter((p) => p.lines.length);
    if (packs.length < 2) return { verdicts: new Map(), status: 'skipped' };
    const queryText = this.describe(q);
    const cacheKey = RankingCache.key(queryText, packs);
    const cached = await this.cache.get(cacheKey);
    if (cached) return { verdicts: cached, status: 'cached' };
    try {
      const result = await this.llm.callFunction({
        purpose: 'rank',
        system: SYSTEM,
        user: `${queryText}\n\nКандидаты:\n${packs.map(EvidencePackBuilder.render).join('\n')}`,
        fn: this.fn(packs.map((p) => p.key)),
        deadlineMs: this.opts.deadlineMs,
        maxTokens: 90 * packs.length + 150,
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

  /** Только оценки со ссылкой на сведения этого кандидата; остальные кандидаты остаются в порядке без ИИ. */
  private verified(items: z.infer<typeof argsSchema>['items'], packs: EvidencePack[]): Map<string, RelevanceVerdict> {
    const byKey = new Map(packs.map((p) => [p.key, p]));
    const out = new Map<string, RelevanceVerdict>();
    let rejected = 0;
    for (const item of items) {
      const pack = byKey.get(item.id);
      if (!pack || out.has(pack.supplierId)) continue;
      const line = EvidencePackBuilder.line(pack, item.basis);
      if (!line || !item.reason.trim()) {
        rejected += 1;
        continue;
      }
      out.set(pack.supplierId, { relevance: item.relevance as RelevanceVerdict['relevance'], reason: clip(item.reason.trim(), 120), quote: clip(line.text, 120), source: line.source });
    }
    if (rejected) this.log.info({ rejected, accepted: out.size }, 'ranking verdicts without evidence reference dropped');
    return out;
  }

  /**
   * Товар и запрос без характеристик: модель их не видит, чтобы не отбраковывать по ним — их сверяют правила.
   * «мука пшеничная высший сорт» → «мука пшеничная», «фанера ФСФ 18 мм» → «фанера».
   */
  private describe(q: SearchQuery): string {
    const product = this.catalog.product(q.productId)?.name ?? this.catalog.category(q.categoryId)?.name;
    const words = new Set((q.attributes ?? []).flatMap((a) => [a.name, a.text ?? '']).flatMap((w) => w.toLowerCase().split(/\s+/)).filter(Boolean));
    const request = q.text
      .split(/[\s,;]+/)
      .filter((w) => w && !/\d/.test(w) && !words.has(w.toLowerCase()) && !/^(мм|см|м|кг|т|шт|сорт[а-я]*)$/i.test(w))
      .join(' ');
    return [product ? `Товар: ${product}` : null, `Запрос: «${clip(request || q.text, 120)}»`].filter(Boolean).join('\n');
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
                relevance: { type: 'integer', enum: [0, 1, 2, 3], description: '3 — сам товар по документу, 2 — сам товар по ОКВЭД, 1 — изделия из товара или смежное, 0 — не подходит' },
                basis: { type: 'string', description: 'Номер строки сведений кандидата, например c3.2' },
                reason: { type: 'string', description: 'Что это за продукция, до 60 символов' },
              },
              required: ['id', 'relevance', 'basis', 'reason'],
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
    const hash = crypto.createHash('sha1').update(query).update(packs.map((p) => `${p.supplierId}:${p.lines.map((l) => `${l.source}:${l.text}`).join('|')}`).join('\n')).digest('hex');
    return `ai:rank:v5:${hash}`;
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
