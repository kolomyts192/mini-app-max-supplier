import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer } from './container';
import { runMigrations } from './infra/db';
import { seedTestData } from './infra/seed';
import { createLogger } from './logger';

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const c = createContainer(config, log);

  await runMigrations(c.db, config.migrationsDir, log);
  if (config.SEED_ON_START) await seedTestData(c.db, config.dataDir, log);
  if (config.SEARCH_DATA === 'real') {
    const { rowCount } = await c.db.query("SELECT 1 FROM suppliers WHERE source_type = 'OFFICIAL' LIMIT 1");
    if (!rowCount) {
      c.search.useDemoData();
      log.warn('official data is not imported yet: search works on the demo test base (run the open data import: see README)');
    }
  }

  // Username бота нужен для deep link https://max.ru/<bot>?startapp=<token>
  if (c.api && !c.botUsername.value) {
    try {
      const me = await c.api.getMe();
      c.botUsername.value = me.username ?? null;
      log.info({ bot: me.username, id: me.user_id }, 'MAX bot identified');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'GET /me failed: check MAX_BOT_TOKEN and network (Russian Trusted Root CA)');
    }
  }
  if (!c.api) log.warn('MAX_BOT_TOKEN is not set: bot is disabled, mini-app works in browser demo mode');

  await c.queue.init();
  c.queue.start((u) => c.orchestrator.handle(u));

  const app = await buildApp(c);
  await app.listen({ port: config.PORT, host: config.HOST });

  if (config.MAX_UPDATES_MODE === 'polling' && c.poller) {
    if (c.api) {
      const subs = await c.api.getSubscriptions().catch(() => null);
      if (subs?.subscriptions?.length) {
        log.warn({ count: subs.subscriptions.length }, 'webhook subscription exists: MAX does not deliver updates via long polling while a webhook is set');
      }
    }
    c.poller.start();
  }
  if (config.MAX_UPDATES_MODE === 'webhook') {
    log.info({ url: config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}/webhooks/max` : null }, 'webhook mode: register subscription with `npm run max:webhook:set`');
  }

  // Ограничение срока хранения пользовательских данных
  const retention = async () => {
    const days = config.DATA_RETENTION_DAYS;
    for (const table of ['search_history', 'analytics_events', 'audit_log', 'category_requests']) {
      await c.db.query(`DELETE FROM ${table} WHERE created_at < now() - make_interval(days => $1::int)`, [days]).catch((err) => log.warn({ err: err.message, table }, 'retention failed'));
    }
  };
  void retention();
  const retentionTimer = setInterval(retention, 6 * 3600 * 1000);

  // Через заданное время после запроса КП бот спрашивает «Поставщики ответили?»
  const followUps = async () => {
    if (!c.api) return;
    for (const due of await c.quotes.dueFollowUps().catch((err) => (log.warn({ err: err.message }, 'quote follow-ups query failed'), []))) {
      try {
        await c.orchestrator.sendQuoteFollowUp(due);
      } catch (err) {
        log.warn({ err: (err as Error).message, id: due.id }, 'quote follow-up not sent');
        await c.quotes.retryLater(due.id).catch(() => undefined);
      }
    }
  };
  const followUpTimer = setInterval(() => void followUps(), 60_000);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearInterval(retentionTimer);
    clearInterval(followUpTimer);
    c.poller?.stop();
    c.queue.stop();
    await app.close().catch(() => undefined);
    c.blockingRedis.disconnect();
    await c.redis.quit().catch(() => undefined);
    await c.db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', err: String(err?.message ?? err) }));
  process.exit(1);
});
