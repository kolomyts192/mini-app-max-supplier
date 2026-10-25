import { SourceUnavailableError } from './types';

/**
 * Клиент API DaData «Организация по ИНН или ОГРН» (https://dadata.ru/api/find-party/).
 * Сведения ЕГРЮЛ/ЕГРИП по ключу API: бесплатный тариф — до 10 000 запросов в сутки, 30 запросов в секунду.
 * Используем только поля бесплатного тарифа: статус, даты, ОГРН/КПП, руководитель, адрес, ОКВЭД, признак недостоверности.
 */
export interface DadataParty {
  inn: string;
  kpp?: string | null;
  ogrn?: string | null;
  ogrn_date?: number | null;
  type?: 'LEGAL' | 'INDIVIDUAL';
  name?: { short_with_opf?: string | null; full_with_opf?: string | null } | null;
  fio?: { surname?: string | null; name?: string | null; patronymic?: string | null } | null;
  state?: {
    status?: 'ACTIVE' | 'LIQUIDATING' | 'LIQUIDATED' | 'BANKRUPT' | 'REORGANIZING' | string;
    code?: string | null;
    actuality_date?: number | null;
    registration_date?: number | null;
    liquidation_date?: number | null;
  } | null;
  management?: { name?: string | null; post?: string | null; start_date?: number | null } | null;
  address?: {
    value?: string | null;
    unrestricted_value?: string | null;
    invalidity?: { code?: string | null; description?: string | null; decision?: { court_name?: string | null; number?: string | null; date?: number | null } | null } | null;
  } | null;
  okved?: string | null;
  okveds?: { code: string; name?: string; main?: boolean }[] | null;
  invalid?: boolean | null;
}

export interface DadataClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Ответ 403/429: исчерпан суточный лимит или превышена частота — дальнейшие запросы стоит отложить. */
export class DadataLimitError extends SourceUnavailableError {
  constructor(message: string) {
    super('FNS_EGRUL', message);
    this.name = 'DadataLimitError';
  }
}

export class DadataClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: DadataClientOptions) {
    this.base = (o.baseUrl ?? 'https://suggestions.dadata.ru/suggestions/api/4_1/rs').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Основная организация (не филиал) по ИНН. null — в ЕГРЮЛ/ЕГРИП не найдена. */
  async findParty(inn: string): Promise<DadataParty | null> {
    const res = await this.fetchImpl(`${this.base}/findById/party`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${this.o.apiKey}` },
      body: JSON.stringify({ query: inn, branch_type: 'MAIN', count: 1 }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
    });
    if (res.status === 401) throw new SourceUnavailableError('FNS_EGRUL', 'DaData: неверный API-ключ (DADATA_API_KEY)');
    if (res.status === 403 || res.status === 429) throw new DadataLimitError(`DaData: лимит запросов исчерпан (HTTP ${res.status})`);
    if (!res.ok) throw new SourceUnavailableError('FNS_EGRUL', `DaData: HTTP ${res.status}`);
    const body = (await res.json()) as { suggestions?: { data?: DadataParty }[] };
    const party = body.suggestions?.find((s) => s.data?.inn === inn)?.data ?? body.suggestions?.[0]?.data ?? null;
    return party ?? null;
  }
}
