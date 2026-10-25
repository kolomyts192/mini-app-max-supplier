import type { Catalog } from '../catalog/catalog';
import type { SearchQuery } from '../domain/types';
import type { Db } from '../infra/db';
import type { Logger } from '../logger';
import { attributeLabel } from '../search/attributes';
import type { SupplierRepository } from '../search/repository';

export type QuoteSource = 'bot' | 'results' | 'card' | 'compare';

export interface QuoteItem {
  id: string;
  name: string;
  inn: string;
  /** Готовый текст запроса КП для этого поставщика. */
  text: string;
  /** Контакты, которые есть в базе; у реальных компаний из открытых данных их, как правило, нет. */
  contacts: { website: string | null; phone: string | null; email: string | null };
  /** Ссылки на поиск сайта и телефона по ИНН: открываются у пользователя, мы ничего не собираем сами. */
  lookup: { label: string; url: string }[];
}

export interface DueFollowUp {
  id: string;
  userId: string;
  query: SearchQuery;
  supplierIds: string[];
}

const OPERATOR = { lte: 'до', gte: 'от', eq: '' } as const;

/** Запрос КП: готовый текст, поиск контактов по ИНН, учёт запросов и ответов на «Поставщики ответили?». */
export class QuoteService {
  constructor(
    private readonly db: Db,
    private readonly repo: SupplierRepository,
    private readonly catalog: Catalog,
    private readonly log: Logger,
    private readonly followUpMinutes: number,
  ) {}

  /** Описание закупки одной строкой: «Фанера, толщина 18 мм, марка ФСФ». */
  describePurchase(q: SearchQuery): string {
    const product = this.catalog.product(q.productId)?.name ?? this.catalog.category(q.categoryId)?.name ?? q.text;
    const attrs = (q.attributes ?? []).map(attributeLabel);
    return [product, ...attrs].filter(Boolean).join(', ');
  }

  private volumeText(q: SearchQuery): string | null {
    if (!q.volume) return null;
    const unit = this.catalog.unit(q.volume.unit)?.short ?? q.volume.unit;
    return `${OPERATOR[q.volume.operator]} ${String(q.volume.value).replace('.', ',')} ${unit}`.trim();
  }

  text(q: SearchQuery, supplier: { name: string; inn: string }): string {
    const region = q.regionCode && q.regionCode !== 'RU' ? this.catalog.region(q.regionCode)?.name : null;
    const volume = this.volumeText(q);
    const docs = q.certificate === 'REQUIRED' ? 'документы на товар (декларация или сертификат соответствия) — обязательное условие' : 'документы на товар (декларация или сертификат соответствия)';
    return [
      `Здравствуйте! Обращаюсь к ${supplier.name} (ИНН ${supplier.inn}).`,
      '',
      `Рассматриваем закупку: ${this.describePurchase(q)}.`,
      region ? `Регион поставки: ${region}.` : null,
      volume ? `Объём: ${volume}.` : null,
      '',
      'Просим направить коммерческое предложение:',
      '— цена за единицу и на весь объём, с НДС или без;',
      '— сроки изготовления и поставки;',
      '— условия оплаты и доставки;',
      `— ${docs}.`,
      '',
      'Контакт для ответа: ________',
      'Спасибо!',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  /** Ссылки на публичный поиск сайта и телефона по ИНН. */
  lookupLinks(inn: string, name: string): QuoteItem['lookup'] {
    const q = encodeURIComponent(`${name} ИНН ${inn} сайт телефон`);
    return [
      { label: 'Найти сайт и телефон', url: `https://yandex.ru/search/?text=${q}` },
      { label: 'Карточка в Rusprofile', url: `https://www.rusprofile.ru/search?query=${encodeURIComponent(inn)}` },
    ];
  }

  async prepare(q: SearchQuery, supplierIds: string[]): Promise<QuoteItem[]> {
    const rows = await this.repo.byIds(supplierIds);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      inn: r.inn,
      text: this.text(q, r),
      contacts: { website: r.website, phone: r.phone, email: r.email },
      lookup: this.lookupLinks(r.inn, r.name),
    }));
  }

  /** Фиксируем, что пользователь отправил или скопировал запрос: через заданное время бот спросит, ответили ли поставщики. */
  async record(userId: string, q: SearchQuery, supplierIds: string[], source: QuoteSource, searchId: string | null): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO quote_requests (user_id, search_id, query, supplier_ids, source, followup_at)
       VALUES ($1, $2, $3, $4::uuid[], $5, now() + make_interval(mins => $6::int)) RETURNING id`,
      [userId, searchId, JSON.stringify(q), supplierIds, source, this.followUpMinutes],
    );
    return rows[0].id;
  }

  /** Запросы, по которым пора спросить «Поставщики ответили?». Только пользователи MAX (числовой id). */
  async dueFollowUps(limit = 20): Promise<DueFollowUp[]> {
    const { rows } = await this.db.query(
      `UPDATE quote_requests SET followup_sent_at = now()
        WHERE id IN (SELECT id FROM quote_requests WHERE followup_sent_at IS NULL AND followup_at <= now() AND user_id ~ '^[0-9]+$'
                      ORDER BY followup_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, user_id, query, supplier_ids`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, query: r.query as SearchQuery, supplierIds: r.supplier_ids }));
  }

  /** Не удалось отправить вопрос: вернуть запрос в очередь, попробуем через 10 минут. */
  async retryLater(id: string): Promise<void> {
    await this.db.query(`UPDATE quote_requests SET followup_sent_at = NULL, followup_at = now() + interval '10 minutes' WHERE id = $1`, [id]);
  }

  /** Ответ пользователя. null — запрос не найден или чужой. */
  async answer(id: string, userId: string, answer: 'yes' | 'no'): Promise<{ query: SearchQuery; supplierIds: string[]; repeated: boolean } | null> {
    const { rows } = await this.db.query(
      `UPDATE quote_requests SET answer = $3, answered_at = now() WHERE id = $1 AND user_id = $2
       RETURNING query, supplier_ids, (SELECT answer IS NOT NULL FROM quote_requests WHERE id = $1) AS repeated`,
      [id, userId, answer],
    );
    if (!rows[0]) {
      this.log.warn({ id }, 'quote answer: request not found');
      return null;
    }
    return { query: rows[0].query as SearchQuery, supplierIds: rows[0].supplier_ids, repeated: !!rows[0].repeated };
  }
}
