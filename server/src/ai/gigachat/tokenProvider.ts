import crypto from 'node:crypto';
import { LlmUnavailableError } from '../llm';

export interface GigaChatAuthConfig {
  authUrl: string;
  /** «Ключ авторизации» из личного кабинета: Base64 от Client ID:Client Secret. */
  authKey: string;
  scope: 'GIGACHAT_API_PERS' | 'GIGACHAT_API_B2B' | 'GIGACHAT_API_CORP';
}

/** Обновлять токен за минуту до истечения: запрос не должен уйти с токеном, который истечёт в пути. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Токен доступа GigaChat (действует 30 минут). Одновременные запросы ждут одну выдачу токена:
 * сервис авторизации ограничивает частоту — 10 запросов в секунду.
 */
export class GigaChatTokenProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly cfg: GigaChatAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(timeoutMs: number): Promise<string> {
    if (this.token && this.token.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.token.value;
    this.pending ??= this.refresh(timeoutMs).finally(() => (this.pending = null));
    return this.pending;
  }

  /** Сервер ответил 401: токен отозван раньше срока. */
  invalidate(): void {
    this.token = null;
  }

  get expiresAt(): number | null {
    return this.token?.expiresAt ?? null;
  }

  private async refresh(timeoutMs: number): Promise<string> {
    const key = this.cfg.authKey.replace(/^Basic\s+/i, '').trim();
    const res = await this.fetchImpl(this.cfg.authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: crypto.randomUUID(),
        Authorization: `Basic ${key}`,
      },
      body: new URLSearchParams({ scope: this.cfg.scope }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: Error) => {
      throw new LlmUnavailableError(err.name === 'TimeoutError' ? 'timeout' : 'unavailable', `GigaChat OAuth: ${err.message}`);
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new LlmUnavailableError('unavailable', `GigaChat OAuth: HTTP ${res.status}${res.status === 401 ? ' — проверьте GIGACHAT_AUTH_KEY и GIGACHAT_SCOPE' : ''} ${body}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_at?: number };
    if (!data.access_token) throw new LlmUnavailableError('unavailable', 'GigaChat OAuth: в ответе нет access_token');
    // expires_at приходит в миллисекундах; если его нет — токен живёт 30 минут
    this.token = { value: data.access_token, expiresAt: data.expires_at ?? this.now() + 30 * 60_000 };
    return data.access_token;
  }
}
