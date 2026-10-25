import { llmLatency, llmRequests, llmTokens } from '../../infra/metrics';
import type { Logger } from '../../logger';
import { CircuitBreaker, CircuitOpenError, sleep } from '../../sources/resilience';
import { type LlmCall, type LlmClient, type LlmResult, LlmUnavailableError } from '../llm';
import { Semaphore } from '../semaphore';
import type { GigaChatTokenProvider } from './tokenProvider';

export interface GigaChatConfig {
  apiUrl: string;
  model: string;
  maxConcurrency: number;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string; function_call?: { name?: string; arguments?: unknown } }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Ответ на повтор: 429 — превышен лимит, 5xx — временная ошибка сервиса. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Клиент GigaChat API: chat/completions с обязательным вызовом функции. Отвечает за токен, число потоков
 * (физлицу — один), сроки, повторы при 429/5xx и circuit breaker: после серии сбоев поиск какое-то время
 * не ждёт модель и сразу работает без ИИ.
 */
export class GigaChatClient implements LlmClient {
  readonly enabled = true;
  private readonly slots: Semaphore;
  private readonly breaker = new CircuitBreaker('GigaChat', 3, 60_000);

  constructor(
    private readonly tokens: GigaChatTokenProvider,
    private readonly cfg: GigaChatConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.slots = new Semaphore(cfg.maxConcurrency);
  }

  async callFunction(call: LlmCall): Promise<LlmResult> {
    const started = Date.now();
    const deadline = started + call.deadlineMs;
    const stop = llmLatency.startTimer({ purpose: call.purpose });
    const release = await this.slots.acquire(call.deadlineMs);
    if (!release) {
      llmRequests.inc({ purpose: call.purpose, outcome: 'busy' });
      throw new LlmUnavailableError('busy', 'GigaChat занят другими запросами (лимит потоков)');
    }
    try {
      const result = await this.breaker.exec(() => this.request(call, deadline));
      llmRequests.inc({ purpose: call.purpose, outcome: 'ok' });
      llmTokens.inc({ purpose: call.purpose, kind: 'prompt' }, result.usage.prompt);
      llmTokens.inc({ purpose: call.purpose, kind: 'completion' }, result.usage.completion);
      this.log.info({ purpose: call.purpose, model: result.model, tokens: result.usage.total, ms: Date.now() - started }, 'gigachat call');
      return result;
    } catch (err) {
      const e = err instanceof CircuitOpenError ? new LlmUnavailableError('unavailable', err.message) : err;
      const reason = e instanceof LlmUnavailableError ? e.reason : 'unavailable';
      llmRequests.inc({ purpose: call.purpose, outcome: reason });
      this.log.warn({ purpose: call.purpose, reason, err: (e as Error).message, ms: Date.now() - started }, 'gigachat call failed');
      throw e instanceof LlmUnavailableError ? e : new LlmUnavailableError('unavailable', (e as Error).message);
    } finally {
      release();
      stop();
    }
  }

  private async request(call: LlmCall, deadline: number): Promise<LlmResult> {
    for (let attempt = 1; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new LlmUnavailableError('timeout', `GigaChat не уложился в ${call.deadlineMs} мс`);
      const token = await this.tokens.get(left);
      const res = await this.fetchImpl(`${this.cfg.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(this.body(call)),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }).catch((err: Error) => {
        throw new LlmUnavailableError(err.name === 'TimeoutError' ? 'timeout' : 'unavailable', `GigaChat: ${err.message}`);
      });
      if (res.status === 401 && attempt === 1) {
        this.tokens.invalidate();
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < 3 && deadline - Date.now() > 1500) {
        await res.body?.cancel();
        await sleep(400 * attempt);
        continue;
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new LlmUnavailableError(res.status === 429 ? 'busy' : 'unavailable', `GigaChat: HTTP ${res.status} ${text}`);
      }
      return this.parse((await res.json()) as ChatResponse, call);
    }
  }

  private body(call: LlmCall) {
    return {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
      functions: [
        {
          name: call.fn.name,
          description: call.fn.description,
          parameters: call.fn.parameters,
          ...(call.fn.examples?.length ? { few_shot_examples: call.fn.examples } : {}),
        },
      ],
      function_call: { name: call.fn.name },
      temperature: 0.1,
      max_tokens: call.maxTokens ?? 1024,
      stream: false,
    };
  }

  private parse(data: ChatResponse, call: LlmCall): LlmResult {
    const fc = data.choices?.[0]?.message?.function_call;
    if (!fc || fc.name !== call.fn.name) throw new LlmUnavailableError('invalid', `GigaChat не вызвал функцию ${call.fn.name}`);
    let args = fc.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        throw new LlmUnavailableError('invalid', 'GigaChat вернул аргументы функции не в формате JSON');
      }
    }
    const u = data.usage ?? {};
    return {
      args,
      model: data.model ?? this.cfg.model,
      usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) },
    };
  }
}
