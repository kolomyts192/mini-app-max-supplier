/**
 * E2E: бот → mini-app → поиск → карточка → сравнение → сохранение.
 * Нужны PostgreSQL и Redis: запускается командой `npm run test:e2e` с E2E=1 (см. README).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { BotTransport } from '../../src/bot/orchestrator';
import { BotNotifier } from '../../src/bot/runtime';
import { loadConfig } from '../../src/config';
import { type Container, createContainer } from '../../src/container';
import { runMigrations } from '../../src/infra/db';
import { seedTestData } from '../../src/infra/seed';
import { signInitData } from '../../src/max/initData';
import { EgrulService } from '../../src/services/egrul';
import { DadataClient } from '../../src/sources/dadata';
import type { NewMessageBody } from '../../src/max/types';
import { silentLog } from '../helpers';

const TOKEN = 'e2e-bot-token-0123456789';
const USER_ID = 900_000_000 + Math.floor(Math.random() * 1000);

interface Sent {
  text: string;
  buttons: { text: string; url?: string; payload?: string }[];
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

function makeEnv(extra: Record<string, string> = {}) {
  // Отдельная база Redis, чтобы не мешать запущенному приложению (очередь, сессии, кэш)
  const redisUrl = `${(process.env.REDIS_URL ?? 'redis://localhost:6379').replace(/\/\d+$/, '')}/15`;
  return loadConfig({
    ...process.env,
    REDIS_URL: redisUrl,
    // Сценарий E2E проверяется на ручной тестовой базе с известными ответами
    SEARCH_DATA: 'test',
    MAX_BOT_TOKEN: TOKEN,
    MAX_BOT_USERNAME: 'proveren_bot',
    MAX_UPDATES_MODE: 'off',
    ALLOW_BROWSER_DEMO: 'false',
    LOG_LEVEL: 'fatal',
    ...extra,
  });
}

describe.skipIf(!process.env.E2E)('E2E', () => {
  let c: Container;
  let app: FastifyInstance;
  const sent: Sent[] = [];

  beforeAll(async () => {
    const transport: BotTransport = {
      async send(_to, body: NewMessageBody) {
        sent.push({ text: body.text, buttons: (body.attachments?.[0]?.payload.buttons.flat() ?? []) as Sent['buttons'] });
      },
      async answer() {},
    };
    c = createContainer(makeEnv(), silentLog, { transport });
    c.notifier = new BotNotifier(null, silentLog);
    await runMigrations(c.db, c.config.migrationsDir, silentLog);
    await seedTestData(c.db, c.config.dataDir, silentLog);
    await c.redis.del('max:updates');
    await c.queue.init();
    c.queue.start((u) => c.orchestrator.handle(u));
    app = await buildApp(c);
  });

  afterAll(async () => {
    await c.db.query('DELETE FROM saved_selections WHERE max_user_id = $1', [String(USER_ID)]);
    c.queue.stop();
    await app.close();
    c.blockingRedis.disconnect();
    await c.redis.quit();
    await c.db.end();
  });

  const initData = (startParam?: string) =>
    signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'e2e',
        user: JSON.stringify({ id: USER_ID, first_name: 'Тест' }),
        ...(startParam ? { start_param: startParam } : {}),
      },
      TOKEN,
    );

  it('полный сценарий', async () => {
    const mid = `mid.e2e.${Date.now()}`;
    const update = {
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: USER_ID, name: 'Тест' },
        recipient: { chat_id: USER_ID + 1, chat_type: 'dialog', user_id: 1 },
        timestamp: Date.now(),
        body: { mid, seq: 1, text: 'Нужен производитель строительной краски в Московской области, оптом, до 2 тонн.' },
      },
    };

    // 1. Webhook отвечает 200 и ставит событие в очередь; повтор — дубликат
    const first = await app.inject({ method: 'POST', url: '/webhooks/max', payload: update });
    expect(first.statusCode).toBe(200);
    expect(first.json().result).toBe('queued');
    const repeat = await app.inject({ method: 'POST', url: '/webhooks/max', payload: update });
    expect(repeat.json().result).toBe('duplicate');

    const question = await waitFor(() => sent.find((s) => s.text.includes('Ищем только производителя?')));
    expect(question.text).toContain('— регион: Московская область;');

    // 2. Выбор типа поставщика → кнопка «Открыть подборку» с search_token
    await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      payload: {
        update_type: 'message_callback',
        timestamp: Date.now(),
        callback: { callback_id: `cb.e2e.${Date.now()}`, payload: 'SET_SUPPLIER_TYPE:MANUFACTURER_ONLY', user: { user_id: USER_ID }, timestamp: Date.now() },
        message: { recipient: { chat_id: USER_ID + 1, chat_type: 'dialog', user_id: 1 }, timestamp: Date.now(), body: { mid: 'q', seq: 2, text: question.text } },
      },
    });
    const ready = await waitFor(() => sent.find((s) => s.text.includes('Параметры готовы')));
    const openUrl = ready.buttons.find((b) => b.text === 'Открыть подборку')?.url;
    expect(openUrl).toMatch(/^https:\/\/max\.ru\/proveren_bot\?startapp=st_[A-Za-z0-9_-]+$/);
    const token = new URL(openUrl!).searchParams.get('startapp')!;

    // Повторный webhook не создал дублирующий ответ
    expect(sent.filter((s) => s.text.includes('Ищем только производителя?'))).toHaveLength(1);

    // 3. Mini-app получает параметры через search_token
    const headers = { 'x-max-init-data': initData(token) };
    const session = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(session.statusCode).toBe(200);
    const launch = session.json().launch;
    expect(launch.type).toBe('search');
    expect(launch.query).toMatchObject({ productId: 'paint_construction', regionCode: '50', supplierType: 'MANUFACTURER_ONLY' });

    // Без подписи — отказ
    expect((await app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { 'x-max-init-data': 'hash=00&user=1' } })).statusCode).toBe(401);

    // 4. Поиск: 3–5 производителей, у каждого объяснение и источники
    const search = await app.inject({ method: 'POST', url: '/api/search', headers, payload: launch.query });
    expect(search.statusCode).toBe(200);
    const res = search.json();
    expect(res.results.length).toBeGreaterThanOrEqual(3);
    expect(res.results.length).toBeLessThanOrEqual(5);
    for (const r of res.results) {
      expect(r.supplierType).toBe('MANUFACTURER');
      expect(r.legalStatus.value).toBe('ACTIVE');
      expect(r.reasons.at(-1).text).toBe('минимальная партия, цена и наличие не подтверждены');
      expect(r.legalStatus.provenance.checkedAt).toBeTruthy();
    }
    expect(res.results[0].regionMatch).toBe('same');
    expect(res.warnings.join(' ')).toContain('Демо-версия');

    // 5. Карточка
    const ctx = encodeURIComponent(JSON.stringify(res.query));
    const card = await app.inject({ method: 'GET', url: `/api/suppliers/${res.results[0].id}?ctx=${ctx}`, headers });
    expect(card.statusCode).toBe(200);
    const cardBody = card.json();
    expect(cardBody.general.inn).toMatch(/^00\d{8}$/);
    expect(cardBody.sources.length).toBeGreaterThan(3);
    expect(cardBody.limitations.join(' ')).toContain('Цена, наличие');
    expect(cardBody.requirements.documents.length).toBeGreaterThan(0);

    // 6. Сравнение до трёх
    const ids = res.results.slice(0, 3).map((r: { id: string }) => r.id);
    const compare = await app.inject({ method: 'GET', url: `/api/compare?ids=${ids.join(',')}&ctx=${ctx}`, headers });
    expect(compare.json().suppliers).toHaveLength(3);

    // 7. Сохранение подборки по MAX ID
    const save = await app.inject({ method: 'POST', url: '/api/saved/selections', headers, payload: { query: res.query, supplierIds: ids } });
    expect(save.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/saved/selections', headers });
    const item = list.json().items.find((i: { id: string }) => i.id === save.json().id);
    expect(item.supplierCount).toBe(3);
    expect(item.title).toBe('Строительная краска, Московская область');
  });

  it('пустая выдача предлагает альтернативные действия', async () => {
    const headers = { 'x-max-init-data': initData() };
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers,
      payload: { text: 'pir плиты', regionCode: '77', strictRegion: true, supplierType: 'MANUFACTURER_ONLY' },
    });
    const body = res.json();
    expect(body.results).toHaveLength(0);
    expect(body.empty.actions.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(['relax_type', 'expand_region', 'edit_product', 'pick_category', 'new_search']));
  });

  it('ЕГРЮЛ по API: сохраняет сведения, риск-сигналы и не запрашивает повторно', async () => {
    const inn = '9990000001';
    const { rows } = await c.db.query<{ id: string }>(
      `INSERT INTO suppliers (inn, name, entity_type, legal_status, region_code, region_name, source_type, is_manual_test_data, checked_at)
       VALUES ($1, 'ООО «ЕГРЮЛ-ТЕСТ»', 'LEGAL_ENTITY', 'ACTIVE', '50', 'Московская область', 'OFFICIAL', false, now())
       ON CONFLICT (inn) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [inn],
    );
    const id = rows[0].id;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const data = { inn, ogrn: '9990000000001', kpp: '500101001', type: 'LEGAL', state: { status: 'LIQUIDATING', registration_date: Date.UTC(2015, 0, 15) }, management: { name: 'Сидоров С. С.', post: 'ДИРЕКТОР' }, invalid: true };
      return new Response(JSON.stringify({ suggestions: [{ data }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const egrul = new EgrulService(c.db, new DadataClient({ apiKey: 'e2e-key-0000', fetchImpl }), silentLog, { maxAgeDays: 7 });
    try {
      expect((await egrul.refresh([inn])).refreshed).toEqual([inn]);
      expect((await egrul.refresh([inn])).refreshed).toEqual([]);
      expect(calls).toBe(1);

      const v = await c.db.query(`SELECT field, value FROM verification_records WHERE supplier_id = $1 AND source = 'FNS_EGRUL'`, [id]);
      expect(Object.fromEntries(v.rows.map((r) => [r.field, r.value]))).toMatchObject({ legal_status: 'ACTIVE', egrul_state: 'LIQUIDATING', registration_date: '2015-01-15', director: 'Директор — Сидоров С. С.' });
      const risks = await c.db.query(`SELECT kind FROM risk_signals WHERE supplier_id = $1 ORDER BY kind`, [id]);
      expect(risks.rows.map((r) => r.kind)).toEqual(['LIQUIDATION', 'UNRELIABLE_INFO']);
      const s = await c.db.query(`SELECT ogrn, kpp, director FROM suppliers WHERE id = $1`, [id]);
      expect(s.rows[0]).toMatchObject({ ogrn: '9990000000001', kpp: '500101001' });
    } finally {
      await c.db.query('DELETE FROM suppliers WHERE id = $1', [id]);
    }
  });

  it('частичный отказ адаптера не ломает поиск', async () => {
    const broken = createContainer(makeEnv({ SIMULATE_SOURCE_FAILURES: 'FSA_DECL,SME_REGISTRY' }), silentLog, { transport: { async send() {}, async answer() {} } });
    const cached = await broken.redis.keys('src:*');
    if (cached.length) await broken.redis.del(...cached);
    const brokenApp = await buildApp(broken);
    try {
      const res = await brokenApp.inject({
        method: 'POST',
        url: '/api/search',
        headers: { 'x-max-init-data': initData() },
        payload: { text: 'монтажная пена', regionCode: '50' },
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.sources.find((s: { id: string }) => s.id === 'FSA_DECL').status).toBe('failed');
      expect(body.warnings[0]).toContain('Часть сведений сейчас недоступна');
    } finally {
      await brokenApp.close();
      broken.blockingRedis.disconnect();
      await broken.redis.quit();
      await broken.db.end();
    }
  });
});
