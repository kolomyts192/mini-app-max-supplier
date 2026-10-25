import { createLlmClient } from './ai/factory';
import { CombinedQueryInterpreter, GigaChatQueryInterpreter, InterpretationCache } from './ai/queryInterpreter';
import { DisabledRelevanceJudge, GigaChatRelevanceJudge, RankingCache, type RelevanceJudge } from './ai/relevanceJudge';
import { QuoteService } from './services/quote';
import { BotOrchestrator, type BotTransport } from './bot/orchestrator';
import { BotNotifier, maxTransport, Poller, UpdateIngestor } from './bot/runtime';
import { SessionStore } from './bot/session';
import { Catalog } from './catalog/catalog';
import type { Config } from './config';
import { createDb, type Db } from './infra/db';
import { StreamQueue } from './infra/queue';
import { createBlockingRedis, createRedis, type RedisClient } from './infra/redis';
import type { Logger } from './logger';
import { MaxApi } from './max/client';
import type { MaxUpdate } from './max/types';
import { SupplierRepository } from './search/repository';
import { type QueryInterpreter, RuleQueryInterpreter } from './search/interpretation';
import { SupplierResolver } from './search/resolver';
import { SearchService } from './search/service';
import { AnalyticsService } from './services/analytics';
import { AuditService } from './services/audit';
import { EgrulService } from './services/egrul';
import { OverviewService } from './services/overview';
import { SavedService } from './services/saved';
import { SearchTokenService } from './services/searchToken';
import { DadataClient } from './sources/dadata';
import { GispClient } from './sources/gispClient';
import { SourceRegistry } from './sources/registry';
import { TestDataStore } from './sources/testDataStore';

export interface Container {
  config: Config;
  log: Logger;
  db: Db;
  redis: RedisClient;
  blockingRedis: RedisClient;
  catalog: Catalog;
  sources: SourceRegistry;
  search: SearchService;
  overview: OverviewService;
  saved: SavedService;
  tokens: SearchTokenService;
  analytics: AnalyticsService;
  audit: AuditService;
  sessions: SessionStore;
  api: MaxApi | null;
  queue: StreamQueue<MaxUpdate>;
  ingestor: UpdateIngestor;
  orchestrator: BotOrchestrator;
  quotes: QuoteService;
  transport: BotTransport;
  notifier: BotNotifier;
  poller: Poller | null;
  botUsername: { value: string | null };
}

export function createContainer(config: Config, log: Logger, overrides: { transport?: BotTransport; now?: () => Date } = {}): Container {
  const db = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const blockingRedis = createBlockingRedis(config.REDIS_URL);
  const catalog = Catalog.load(config.dataDir);
  const store = new TestDataStore(db);
  const gisp =
    config.GISP_API_BASE && config.GISP_JWT && config.GISP_PRODUCTS_PATH && config.GISP_PP719_PATH
      ? new GispClient({ baseUrl: config.GISP_API_BASE, jwt: config.GISP_JWT, productsPath: config.GISP_PRODUCTS_PATH, pp719Path: config.GISP_PP719_PATH, log })
      : undefined;
  const egrul = new EgrulService(db, config.DADATA_API_KEY ? new DadataClient({ apiKey: config.DADATA_API_KEY }) : null, log, { maxAgeDays: config.EGRUL_MAX_AGE_DAYS });
  const sources = new SourceRegistry(store, catalog, redis, log, { mode: 'snapshot', simulatedFailures: config.simulatedFailures, gisp, egrulLive: egrul.enabled });
  const analytics = new AnalyticsService(db, log);
  const audit = new AuditService(db, log);
  const rules = new RuleQueryInterpreter(catalog);
  // GigaChat: разбор запроса и оценка кандидатов; без ключа — правила и формула ТЗ
  const llm = createLlmClient(config, log);
  const interpreter: QueryInterpreter = llm.enabled
    ? new CombinedQueryInterpreter(rules, new GigaChatQueryInterpreter(llm, catalog), new InterpretationCache(redis), log, config.GIGACHAT_TIMEOUT_MS)
    : rules;
  const judge: RelevanceJudge = llm.enabled
    ? new GigaChatRelevanceJudge(llm, catalog, new RankingCache(redis), log, { deadlineMs: config.GIGACHAT_RANK_TIMEOUT_MS, top: config.GIGACHAT_RERANK_TOP })
    : new DisabledRelevanceJudge();
  const search = new SearchService({
    db,
    repo: new SupplierRepository(db),
    resolver: new SupplierResolver(sources, store),
    sources,
    catalog,
    analytics,
    audit,
    log,
    egrul,
    egrulTop: config.EGRUL_TOP_CANDIDATES,
    demoTrustManual: config.DEMO_TRUST_MANUAL_DATA,
    dataMode: config.SEARCH_DATA,
    interpreter,
    judge,
    now: overrides.now,
  });
  const overview = new OverviewService(db, catalog, analytics, () => search.imports(), () => search.dataMode, sources.officialLive);
  const saved = new SavedService(db);
  const tokens = new SearchTokenService(redis, config.SEARCH_TOKEN_TTL_SEC);
  const sessions = new SessionStore(redis);
  const api = config.MAX_BOT_TOKEN ? new MaxApi(config.MAX_BOT_TOKEN, config.MAX_API_BASE, log) : null;
  const queue = new StreamQueue<MaxUpdate>(redis, blockingRedis, 'max:updates', 'bot', log);
  const ingestor = new UpdateIngestor(redis, queue, log);
  const botUsername = { value: config.MAX_BOT_USERNAME ?? null };
  const transport: BotTransport =
    overrides.transport ??
    (api
      ? maxTransport(api)
      : {
          async send(to, body) {
            log.info({ to, text: body.text.slice(0, 80) }, 'bot disabled: message not sent');
          },
          async answer() {},
        });
  const quotes = new QuoteService(db, new SupplierRepository(db), catalog, log, config.QUOTE_FOLLOWUP_MINUTES);
  const orchestrator = new BotOrchestrator(
    { quotes, sessions, catalog, tokens, search, saved, analytics, log, openAppMode: config.MAX_OPEN_APP_BUTTON, botUsername: () => botUsername.value, interpreter, rules },
    transport,
  );
  const notifier = new BotNotifier(api, log);
  const poller = api && config.MAX_UPDATES_MODE === 'polling' ? new Poller(api, redis, ingestor, log) : null;

  return {
    config, log, db, redis, blockingRedis, catalog, sources, search, overview, saved, tokens, analytics, audit, sessions,
    api, queue, ingestor, orchestrator, quotes, transport, notifier, poller, botUsername,
  };
}
