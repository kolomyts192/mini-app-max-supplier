/**
 * Порт языковой модели. Модель вызывается только через функцию с JSON-схемой: ответ всегда структурирован,
 * а свободный текст модели в продукт не попадает. Реализация — GigaChatClient; без ключа — DisabledLlmClient.
 */

/** JSON-схема параметров функции (подмножество, которое понимает GigaChat). */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number)[];
}

/** Функция, которую модель обязана вызвать; её аргументы и есть ответ. */
export interface LlmFunction {
  name: string;
  description: string;
  parameters: JsonSchema & { type: 'object' };
  /** Примеры «запрос → аргументы» для модели. */
  examples?: { request: string; params: Record<string, unknown> }[];
}

export type LlmPurpose = 'interpret' | 'rank';

export interface LlmCall {
  purpose: LlmPurpose;
  system: string;
  user: string;
  fn: LlmFunction;
  /** Общий срок вместе с ожиданием свободного потока. */
  deadlineMs: number;
  maxTokens?: number;
}

export interface LlmResult {
  args: unknown;
  model: string;
  usage: { prompt: number; completion: number; total: number };
}

export type LlmFailure = 'disabled' | 'timeout' | 'busy' | 'unavailable' | 'invalid';

/** Модель недоступна или ответила не по схеме: поиск продолжается без ИИ. */
export class LlmUnavailableError extends Error {
  constructor(
    readonly reason: LlmFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export interface LlmClient {
  readonly enabled: boolean;
  callFunction(call: LlmCall): Promise<LlmResult>;
}

/** Ключ не задан или ИИ выключен: каждый вызов сразу отказывает, и поиск работает на правилах. */
export class DisabledLlmClient implements LlmClient {
  readonly enabled = false;

  async callFunction(): Promise<LlmResult> {
    throw new LlmUnavailableError('disabled', 'ИИ не подключён: не задан GIGACHAT_AUTH_KEY или GIGACHAT_ENABLED=false');
  }
}
