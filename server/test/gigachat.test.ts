import { describe, expect, it } from 'vitest';
import { GigaChatClient } from '../src/ai/gigachat/gigachatClient';
import { GigaChatTokenProvider } from '../src/ai/gigachat/tokenProvider';
import { DisabledLlmClient, type LlmCall, LlmUnavailableError } from '../src/ai/llm';
import { CombinedQueryInterpreter, GigaChatQueryInterpreter, InterpretationCache } from '../src/ai/queryInterpreter';
import { CitationVerifier, GigaChatRelevanceJudge, RankingCache } from '../src/ai/relevanceJudge';
import { searchQuerySchema } from '../src/domain/types';
import { attributeLabel } from '../src/search/attributes';
import type { SupplierSummary } from '../src/search/dto';
import { RuleQueryInterpreter } from '../src/search/interpretation';
import { withVerdict } from '../src/search/service';
import { catalog, FakeRedis, silentLog, supplier } from './helpers';

const AUTH = 'https://auth.test/api/v2/oauth';
const API = 'https://api.test/v1';

/** Поддельный GigaChat: OAuth и chat/completions по сценарию, с журналом запросов. */
class FakeGigaChat {
  readonly calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  tokenIssued = 0;
  /** Ответы chat/completions по очереди: аргументы функции, HTTP-код или задержка. */
  replies: ({ args: unknown } | { status: number } | { delayMs: number; args: unknown })[] = [];

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    this.calls.push({ url: u, headers, body: String(init?.body ?? '') });
    if (u === AUTH) {
      this.tokenIssued += 1;
      return Response.json({ access_token: `token-${this.tokenIssued}`, expires_at: Date.now() + 30 * 60_000 });
    }
    const reply = this.replies.shift() ?? { status: 500 };
    if ('status' in reply) return new Response('ошибка', { status: reply.status });
    if ('delayMs' in reply) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({
      model: body.model,
      choices: [{ message: { function_call: { name: body.functions[0].name, arguments: (reply as { args: unknown }).args } }, finish_reason: 'function_call' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  };

  get chatCalls() {
    return this.calls.filter((c) => c.url.endsWith('/chat/completions'));
  }
}

const client = (fake: FakeGigaChat, maxConcurrency = 1) =>
  new GigaChatClient(new GigaChatTokenProvider({ authUrl: AUTH, authKey: 'Basic a2V5OnNlY3JldA==', scope: 'GIGACHAT_API_PERS' }, fake.fetch as typeof fetch), { apiUrl: API, model: 'GigaChat-2-Pro', maxConcurrency }, silentLog, fake.fetch as typeof fetch);

const call = (deadlineMs = 2000): LlmCall => ({
  purpose: 'interpret',
  system: 's',
  user: 'u',
  deadlineMs,
  fn: { name: 'extract_purchase_query', description: 'd', parameters: { type: 'object', properties: {} } },
});

describe('клиент GigaChat', () => {
  it('токен выдаётся один раз на параллельные запросы, функция вызывается обязательно', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [{ args: { a: 1 } }, { args: '{"a":2}' }];
    const c = client(fake, 2);
    const [r1, r2] = await Promise.all([c.callFunction(call()), c.callFunction(call())]);
    expect([r1.args, r2.args]).toEqual([{ a: 1 }, { a: 2 }]);
    expect(fake.tokenIssued).toBe(1);
    const oauth = fake.calls[0];
    expect(oauth.headers.Authorization).toBe('Basic a2V5OnNlY3JldA==');
    expect(oauth.body).toBe('scope=GIGACHAT_API_PERS');
    const body = JSON.parse(fake.chatCalls[0].body);
    expect(body).toMatchObject({ model: 'GigaChat-2-Pro', function_call: { name: 'extract_purchase_query' }, stream: false });
    expect(r1.usage.total).toBe(120);
  });

  it('401 — новый токен и повтор; 429 — повтор', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [{ status: 401 }, { status: 429 }, { args: { ok: true } }];
    const r = await client(fake).callFunction(call(5000));
    expect(r.args).toEqual({ ok: true });
    expect(fake.tokenIssued).toBe(2);
    expect(fake.chatCalls).toHaveLength(3);
  });

  it('не уложился в срок — timeout; поток занят — busy', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [{ delayMs: 400, args: {} }];
    const c = client(fake, 1);
    const slow = c.callFunction(call(200)).catch((e) => e);
    const waiting = c.callFunction(call(100)).catch((e) => e);
    expect(((await waiting) as LlmUnavailableError).reason).toBe('busy');
    expect(((await slow) as LlmUnavailableError).reason).toBe('timeout');
  });

  it('без ключа — клиент-заглушка отказывает сразу', async () => {
    await expect(new DisabledLlmClient().callFunction()).rejects.toMatchObject({ reason: 'disabled' });
  });
});

describe('разбор запроса GigaChat', () => {
  const rules = new RuleQueryInterpreter(catalog);
  const interpreter = (fake: FakeGigaChat) => new GigaChatQueryInterpreter(client(fake), catalog);

  it('товар из справочника, регион по справочнику, характеристики — только из текста запроса', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [{
      args: {
        product_id: 'plywood', category_id: 'lumber', product_confidence: 0.95, region: 'Москва',
        attributes: [{ name: 'толщина', value: 18, unit: 'мм' }, { name: 'толщина', value: 21, unit: 'мм' }, { name: 'марка', text: 'ФСФ' }, { name: 'сорт', text: 'E1' }],
        supplier_type: 'unknown', terms: ['фанера', 'фанера ФСФ', '18 мм'], clarify: '',
      },
    }];
    const r = await interpreter(fake).interpret('фанера фсф 18 мм, Москва', 2000);
    expect(r.product).toMatchObject({ productId: 'plywood', categoryId: 'lumber' });
    expect(r.region).toMatchObject({ code: '77' });
    expect(r.attributes.map(attributeLabel)).toEqual(['толщина 18 мм', 'марка ФСФ']);
    expect(r.terms).toEqual(['фанера', 'фанера ФСФ']);
    const prompt = JSON.parse(fake.chatCalls[0].body);
    expect(prompt.functions[0].parameters.properties.product_id.enum).toContain('plywood');
  });

  it('выдуманный товар отбрасывается; без ИИ, при сбое и из кэша — понятный статус', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [
      { args: { product_id: 'kitchen_furniture', category_id: 'furniture', product_confidence: 0.9, region: '', attributes: [], supplier_type: 'unknown', terms: ['кухонная мебель'], clarify: 'Какой материал фасадов?' } },
      { status: 500 },
    ];
    const combined = new CombinedQueryInterpreter(rules, interpreter(fake), new InterpretationCache(new FakeRedis() as never), silentLog, 2000);
    const first = await combined.interpret('кухонная мебель на заказ в Казани');
    expect(first).toMatchObject({ source: 'ai', status: 'ok', product: { productId: 'kitchen_furniture' }, region: { code: '16' }, clarify: 'Какой материал фасадов?' });
    expect((await combined.interpret('кухонная мебель на заказ в Казани')).status).toBe('cached');
    const failed = await combined.interpret('фанера 18 мм');
    expect(failed).toMatchObject({ source: 'rules', status: 'error', product: { productId: 'plywood' } });

    const bogus = new FakeGigaChat();
    bogus.replies = [{ args: { product_id: 'gold_bars', category_id: 'none', product_confidence: 0.99, region: '', attributes: [], terms: [], clarify: '' } }];
    expect((await interpreter(bogus).interpret('золотые слитки', 2000)).product).toBeNull();
  });
});

describe('оценка кандидатов GigaChat', () => {
  const summary = (id: string, productName: string): SupplierSummary =>
    ({
      id, name: id, score: 0.8, scoreComponents: { productMatch: 0.9 }, reasons: [{ kind: 'ok', text: 'по ОКВЭД' }, { kind: 'warn', text: 'тип не определён' }],
      documents: { total: 1, active: 1, relevantActive: 1, items: [{ type: 'DECLARATION', statusLabel: 'Действует', match: 'product', productName }] },
      match: { basis: 'okved_exact', label: 'по ОКВЭД товара', evidence: null, attributes: [], ai: null },
    }) as unknown as SupplierSummary;
  const q = searchQuerySchema.parse({ text: 'фанера 18 мм', productId: 'plywood', categoryId: 'lumber', interpreted: true });

  it('оценка учитывается только с цитатой из сведений именно этого кандидата', async () => {
    const fake = new FakeGigaChat();
    fake.replies = [{
      args: {
        items: [
          { id: 'c1', relevance: 3, reason: 'Декларация на фанеру', quote: 'Фанера общего назначения' },
          { id: 'c2', relevance: 3, reason: 'Фанера марки ФСФ', quote: 'фанера ФСФ толщиной 18 мм' },
        ],
      },
    }];
    const judge = new GigaChatRelevanceJudge(client(fake), catalog, new RankingCache(new FakeRedis() as never), silentLog, { deadlineMs: 2000, top: 30 });
    const rows = [supplier({ id: 'a', okved_main: { code: '16.21.11', name: 'Производство фанеры' } }), supplier({ id: 'b', okved_main: { code: '16.10', name: 'Распиловка' } })];
    const { verdicts, status } = await judge.judge(q, [
      { summary: summary('a', 'Фанера общего назначения ГОСТ 3916.1'), row: rows[0] },
      { summary: summary('b', 'Доска обрезная'), row: rows[1] },
    ]);
    expect(status).toBe('ok');
    expect([...verdicts.keys()]).toEqual(['a']);
    const user = JSON.parse(fake.chatCalls[0].body).messages[1].content as string;
    expect(user).toContain('[c1]');
    expect(user).not.toContain('ООО «Тест-Краска»');
  });

  it('применение оценки: среднее правил и ИИ в компоненте товара, объяснение ИИ вторым пунктом', () => {
    const s = withVerdict(summary('a', 'Фанера'), { relevance: 1, reason: 'Только смежная продукция', quote: 'Фанера' });
    expect(s.scoreComponents.productMatch).toBe(0.7);
    expect(s.score).toBe(0.73);
    expect(s.reasons[1]).toEqual({ kind: 'warn', text: 'оценка ИИ: Только смежная продукция', source: 'ai' });
    expect(new CitationVerifier().verify('«фанера   ОБЩЕГО назначения»', { key: 'c1', supplierId: 'a', lines: ['Декларация (действует): Фанера общего назначения'] })).toBe(true);
  });
});
