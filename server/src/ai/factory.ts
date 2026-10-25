import type { Config } from '../config';
import type { Logger } from '../logger';
import { GigaChatClient } from './gigachat/gigachatClient';
import { GigaChatTokenProvider } from './gigachat/tokenProvider';
import { DisabledLlmClient, type LlmClient } from './llm';

/** GigaChat при заданном ключе и GIGACHAT_ENABLED; иначе клиент-заглушка, и поиск работает на правилах. */
export function createLlmClient(config: Config, log: Logger, fetchImpl: typeof fetch = fetch): LlmClient {
  if (!config.GIGACHAT_ENABLED || !config.GIGACHAT_AUTH_KEY) return new DisabledLlmClient();
  const tokens = new GigaChatTokenProvider({ authUrl: config.GIGACHAT_AUTH_URL, authKey: config.GIGACHAT_AUTH_KEY, scope: config.GIGACHAT_SCOPE }, fetchImpl);
  return new GigaChatClient(tokens, { apiUrl: config.GIGACHAT_API_URL, model: config.GIGACHAT_MODEL, maxConcurrency: config.GIGACHAT_MAX_CONCURRENCY }, log, fetchImpl);
}
