import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'pp_' });

export const httpRequests = new client.Counter({
  name: 'pp_http_requests_total',
  help: 'HTTP-запросы по маршруту и коду ответа',
  labelNames: ['route', 'method', 'status'],
  registers: [registry],
});

export const sourceRequests = new client.Counter({
  name: 'pp_source_requests_total',
  help: 'Обращения к адаптерам источников',
  labelNames: ['source', 'outcome'],
  registers: [registry],
});

export const sourceLatency = new client.Histogram({
  name: 'pp_source_latency_seconds',
  help: 'Время ответа адаптеров источников',
  labelNames: ['source'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const searches = new client.Counter({
  name: 'pp_searches_total',
  help: 'Поиски по результату (nonempty/empty) и происхождению',
  labelNames: ['result', 'origin'],
  registers: [registry],
});

export const searchLatency = new client.Histogram({
  name: 'pp_search_latency_seconds',
  help: 'Время до первой выдачи',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
  registers: [registry],
});

export const botUpdates = new client.Counter({
  name: 'pp_bot_updates_total',
  help: 'Обновления MAX по типу и исходу',
  labelNames: ['type', 'outcome'],
  registers: [registry],
});

export const maxApiErrors = new client.Counter({
  name: 'pp_max_api_errors_total',
  help: 'Ошибки вызовов MAX Bot API',
  labelNames: ['method', 'status'],
  registers: [registry],
});

export const llmRequests = new client.Counter({
  name: 'pp_llm_requests_total',
  help: 'Запросы к языковой модели по назначению (разбор, оценка) и исходу',
  labelNames: ['purpose', 'outcome'],
  registers: [registry],
});

export const llmTokens = new client.Counter({
  name: 'pp_llm_tokens_total',
  help: 'Токены языковой модели: prompt — запрос, completion — ответ, precached — часть запроса из кэша модели',
  labelNames: ['purpose', 'kind'],
  registers: [registry],
});

export const llmLatency = new client.Histogram({
  name: 'pp_llm_latency_seconds',
  help: 'Время ответа языковой модели вместе с ожиданием свободного потока',
  labelNames: ['purpose'],
  buckets: [0.25, 0.5, 1, 2, 3, 4, 6, 10],
  registers: [registry],
});
