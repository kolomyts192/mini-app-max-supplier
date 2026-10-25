import { beforeEach, describe, expect, it } from 'vitest';
import { BotOrchestrator, type BotTransport } from '../src/bot/orchestrator';
import { SessionStore } from '../src/bot/session';
import type { MaxUpdate, NewMessageBody } from '../src/max/types';
import { type QueryInterpreter, RuleQueryInterpreter } from '../src/search/interpretation';
import { catalog, FakeRedis, silentLog } from './helpers';

const rules = new RuleQueryInterpreter(catalog);

interface Sent {
  kind: 'send' | 'answer';
  text: string;
  buttons: { text: string; payload?: string; url?: string }[];
}

const fakeSupplier = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  inn: `770000000${i}`,
  name: `ООО «Тест ${i}»`,
  region: { code: '16', name: 'Республика Татарстан' },
  supplierType: 'MANUFACTURER',
  supplierTypeLabel: 'Производитель',
  supplierTypeBasis: 'в реестре МСП компания указала производимую продукцию',
  documents: { items: [] },
  ...over,
});

function setup(total = 4, interpreter: QueryInterpreter = rules) {
  const sent: Sent[] = [];
  const transport: BotTransport = {
    async send(_to, body: NewMessageBody) {
      sent.push({ kind: 'send', text: body.text, buttons: (body.attachments?.[0]?.payload.buttons.flat() ?? []) as Sent['buttons'] });
    },
    async answer(_id, body) {
      sent.push({ kind: 'answer', text: body.message?.text ?? '', buttons: [] });
    },
  };
  const searches: unknown[] = [];
  const quoteLog: unknown[] = [];
  const bot = new BotOrchestrator(
    {
      quotes: {
        prepare: async (_q: unknown, ids: string[]) => ids.map((id) => ({ id, name: `ООО «${id.slice(-1)}»`, inn: '7700000000', text: 'Здравствуйте! КП', contacts: { website: null, phone: null, email: null }, lookup: [{ label: 'Найти сайт и телефон', url: 'https://yandex.ru/search/?text=x' }] })),
        record: async (...a: unknown[]) => (quoteLog.push(a), 'q1'),
        describePurchase: () => 'Фанера',
        answer: async () => ({ query: { text: 'фанера' }, supplierIds: [], repeated: false }),
      } as never,
      sessions: new SessionStore(new FakeRedis() as never),
      catalog,
      tokens: { create: async () => ({ token: 'st_testtoken' }) } as never,
      search: {
        search: async (q: unknown) => {
          searches.push(q);
          return {
            total,
            counts: { total, evaluated: total, matched: total, shown: Math.min(total, 5), isEstimate: false },
            sources: [],
            results: [fakeSupplier(1), fakeSupplier(2, { documents: { items: [{ type: 'DECLARATION', number: 'ЕАЭС N RU Д-RU.TEST', manufacturerInn: '7700000002' }] } }), fakeSupplier(3, { supplierTypeBasis: null })].slice(0, Math.min(total, 5)),
            empty: total ? null : { actions: [{ id: 'relax_type', label: 'Убрать фильтр «только производитель»', patch: {} }] },
          };
        },
        imports: async () => [
          { dataset: 'rsmp', source: 'SME_REGISTRY', title: 'МСП', dataDate: '2026-10-10', rowsMatched: 1 },
          { dataset: 'sshr', source: 'FNS_PB', title: 'Численность', dataDate: '2026-09-25', rowsMatched: 1 },
        ],
      } as never,
      saved: { listSelections: async () => [] } as never,
      analytics: { track: () => undefined } as never,
      log: silentLog,
      openAppMode: 'link',
      botUsername: () => 'proveren_bot',
      interpreter,
      rules,
    },
    transport,
  );
  return { bot, sent, searches, quoteLog };
}

const msg = (text: string, mid = `m${Math.random()}`): MaxUpdate => ({
  update_type: 'message_created',
  timestamp: Date.now(),
  message: { sender: { user_id: 7 }, recipient: { chat_id: 100, chat_type: 'dialog', user_id: 1 }, timestamp: Date.now(), body: { mid, seq: 1, text } },
});

const press = (payload: string, text = 'предыдущее сообщение'): MaxUpdate => ({
  update_type: 'message_callback',
  timestamp: Date.now(),
  callback: { callback_id: `cb${Math.random()}`, payload, user: { user_id: 7 }, timestamp: Date.now() },
  message: { recipient: { chat_id: 100, chat_type: 'dialog', user_id: 1 }, timestamp: Date.now(), body: { mid: 'x', seq: 1, text } },
});

const lastSend = (sent: Sent[]) => sent.filter((s) => s.kind === 'send').at(-1)!;

describe('bot dialog', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('/start приветствует и предлагает начать поиск', async () => {
    await ctx.bot.handle(msg('/start'));
    const m = lastSend(ctx.sent);
    expect(m.text).toContain('Здравствуйте');
    expect(m.buttons.map((b) => b.text)).toContain('Найти поставщика');
  });

  it('сценарий из ТЗ: одно сообщение → вопрос о типе поставщика → кнопка «Открыть подборку»', async () => {
    await ctx.bot.handle(msg('Нужен производитель строительной краски в Московской области, оптом, до 2 тонн.'));
    let m = lastSend(ctx.sent);
    expect(m.text).toContain('Я понял запрос так:');
    expect(m.text).toContain('— товар: строительная краска;');
    expect(m.text).toContain('— регион: Московская область;');
    expect(m.text).toContain('— формат: опт;');
    expect(m.text).toContain('— объём: до 2 т.');
    expect(m.text).toContain('Ищем только производителя?');
    expect(m.buttons.map((b) => b.text)).toEqual(['Да, только производителя', 'Производителя или дистрибьютора', 'Любого поставщика', 'Изменить параметры']);
    await ctx.bot.handle(press('SET_SUPPLIER_TYPE:MANUFACTURER_ONLY', m.text));
    m = lastSend(ctx.sent);
    expect(m.text).toContain('Параметры готовы. Откройте подборку');
    const open = m.buttons.find((b) => b.text === 'Открыть подборку');
    expect(open?.url).toBe('https://max.ru/proveren_bot?startapp=st_testtoken');
    expect(m.buttons.map((b) => b.text)).toContain('Новый поиск');
  });

  it('после подтверждения: «Отобрал 3 из 3» и три лучших с основанием типа в чате', async () => {
    ctx = setup(3);
    await ctx.bot.handle(msg('Нужна фанера ФСФ 18 мм, Татарстан, только производитель'));
    await ctx.bot.handle(press('CONFIRM_QUERY'));
    const m = lastSend(ctx.sent);
    expect(m.text).toContain('Отобрал 3 из 3. Лучшие три:');
    expect(m.text).toContain('1. ООО «Тест 1», Республика Татарстан — производитель (заявлено в реестре МСП)');
    expect(m.text).toContain('2. ООО «Тест 2», Республика Татарстан — производитель (по декларации ЕАЭС N RU Д-RU.TEST)');
    expect(m.text).toContain('3. ООО «Тест 3», Республика Татарстан — производитель (тип не подтверждён, определён по ОКВЭД)');
    expect(m.buttons.find((b) => b.text.startsWith('Запросить КП'))?.payload).toBe('QUOTE:st_testtoken');
  });

  it('приветствие: строка источников с датами и кнопка «Пример запроса»', async () => {
    await ctx.bot.handle(msg('/start'));
    const m = lastSend(ctx.sent);
    expect(m.text).toContain('Источники: реестр МСП на 10.10.2026 · налоги и численность ФНС на 25.09.2026.');
    expect(m.buttons.map((b) => b.text)).toContain('Пример запроса');
    await ctx.bot.handle(press('EXAMPLE'));
    expect(ctx.sent.filter((x) => x.kind === 'send').map((x) => x.text).join('\n')).toContain('Пример запроса:');
  });

  it('«Запросить КП»: текст для каждого поставщика, ссылки на поиск контактов, запись для опроса', async () => {
    ctx = setup(3);
    await ctx.bot.handle(msg('Нужна фанера ФСФ 18 мм, Татарстан, только производитель'));
    await ctx.bot.handle(press('CONFIRM_QUERY'));
    const before = ctx.sent.length;
    await ctx.bot.handle(press('QUOTE'));
    const texts = ctx.sent.slice(before).filter((x) => x.kind === 'send').map((x) => x.text);
    expect(texts).toHaveLength(4);
    expect(texts[1]).toContain('yandex.ru/search');
    expect(texts[1]).toContain('Здравствуйте! КП');
    expect(ctx.quoteLog).toHaveLength(1);
  });

  it('опрос «Поставщики ответили?»: при «нет» бот присылает подборку заново', async () => {
    ctx = setup(3);
    await ctx.bot.sendQuoteFollowUp({ id: 'q1', userId: '7', query: { text: 'фанера' } as never, supplierIds: [] });
    const ask = lastSend(ctx.sent);
    expect(ask.text).toContain('Поставщики ответили?');
    expect(ask.buttons.map((b) => b.payload)).toEqual(['QUOTE_ANSWER:yes:q1', 'QUOTE_ANSWER:no:q1']);
    await ctx.bot.handle(press('QUOTE_ANSWER:no:q1'));
    expect(lastSend(ctx.sent).text).toContain('Отобрал 3 из 3');
  });

  it('уточняет только недостающее: регион и тип поставщика (не больше трёх вопросов)', async () => {
    await ctx.bot.handle(msg('нужна монтажная пена'));
    let m = lastSend(ctx.sent);
    expect(m.text).toContain('В каком регионе ищем?');
    await ctx.bot.handle(press('SET_REGION:77', m.text));
    m = lastSend(ctx.sent);
    expect(m.text).toContain('Ищем только производителя?');
    expect(m.buttons.map((b) => b.text)).toEqual(['Да, только производителя', 'Производителя или дистрибьютора', 'Любого поставщика', 'Изменить параметры']);
    await ctx.bot.handle(press('SET_SUPPLIER_TYPE:MANUFACTURER_ONLY', m.text));
    m = lastSend(ctx.sent);
    expect(m.text).toContain('Параметры готовы');
    const questions = ctx.sent.filter((s) => s.kind === 'send' && /\?$/.test(s.text.trim()));
    expect(questions.length).toBeLessThanOrEqual(3);
    expect(ctx.searches.at(-1)).toMatchObject({ productId: 'mounting_foam', regionCode: '77', supplierType: 'MANUFACTURER_ONLY' });
  });

  it('текстовый ответ на вопрос о регионе тоже принимается', async () => {
    await ctx.bot.handle(msg('саморезы'));
    await ctx.bot.handle(msg('в Тульской области'));
    expect(lastSend(ctx.sent).text).toContain('— регион: Тульская область');
  });

  it('нераспознанный товар — предлагает категории', async () => {
    await ctx.bot.handle(msg('нужны автомобильные шины'));
    const m = lastSend(ctx.sent);
    expect(m.text).toContain('Не нашёл такой товар');
    expect(m.buttons.length).toBe(catalog.data.categories.length);
  });

  it('явный тип поставщика не переспрашивается, сразу подтверждение', async () => {
    await ctx.bot.handle(msg('саморезы только от производителя в Москве'));
    const m = lastSend(ctx.sent);
    expect(m.text).toContain('— тип поставщика: только производитель.');
    expect(m.buttons.map((b) => b.text)).toEqual(['Подтвердить', 'Изменить параметры']);
  });

  it('каждый параметр можно изменить', async () => {
    await ctx.bot.handle(msg('саморезы в Москве, любой поставщик'));
    await ctx.bot.handle(press('CHANGE_QUERY'));
    const m = lastSend(ctx.sent);
    expect(m.buttons.map((b) => b.text)).toEqual(['Товар', 'Регион', 'Тип поставщика', 'Объём', 'Документы', 'Готово']);
    await ctx.bot.handle(press('SET_CERTIFICATE:REQUIRED'));
    expect(lastSend(ctx.sent).text).toContain('документы обязательны');
  });

  it('пустая выдача — альтернативные действия прямо в чате', async () => {
    const empty = setup(0);
    await empty.bot.handle(msg('производитель PIR плит в Москве'));
    await empty.bot.handle(press('SET_SUPPLIER_TYPE:MANUFACTURER_ONLY'));
    const m = lastSend(empty.sent);
    expect(m.text).toContain('ничего не найдено');
    expect(m.buttons.map((b) => b.text)).toEqual(expect.arrayContaining(['Убрать фильтр «только производитель»', 'Изменить параметры', 'Новый поиск']));
  });

  it('/cancel сбрасывает поиск, /saved без подборок подсказывает, как сохранить', async () => {
    await ctx.bot.handle(msg('краска'));
    await ctx.bot.handle(msg('/cancel'));
    expect(lastSend(ctx.sent).text).toContain('Поиск отменён');
    await ctx.bot.handle(msg('/saved'));
    expect(lastSend(ctx.sent).text).toContain('Сохранённых подборок пока нет');
  });

  it('нажатие кнопки подтверждается ответом на callback', async () => {
    await ctx.bot.handle(msg('саморезы'));
    await ctx.bot.handle(press('SET_REGION:50', 'В каком регионе ищем?'));
    const answer = ctx.sent.find((s) => s.kind === 'answer');
    expect(answer?.text).toContain('→ Московская область');
  });
});

describe('честные цифры в боте', () => {
  it('при неполной проверке категории не обещает, что подошли все', async () => {
    const { T } = await import('../src/bot/texts');
    expect(T.found({ total: 1694, evaluated: 150, matched: 37, shown: 5, isEstimate: true }).replace(/\s/g, ' ')).toBe(
      'В категории 1 694 компании. Проверил 150 лучших совпадений — подходят 37. В подборке — 5 лучших.',
    );
    expect(T.found({ total: 4, evaluated: 4, matched: 4, shown: 4, isEstimate: false })).toBe('По вашим параметрам подходят 4 компании. В подборке — 4 лучших.');
  });
});

describe('уточнение характеристик', () => {
  /** Разбор, как у ИИ: предлагает вопрос о характеристиках, если их нет в запросе. */
  const withClarify: QueryInterpreter = {
    async interpret(text) {
      const r = rules.interpretSync(text);
      return { ...r, clarify: r.attributes.length ? null : 'Какая толщина и марка фанеры нужны?', source: 'ai', status: 'ok' };
    },
  };

  it('вопрос — после региона и типа, ответ попадает в сводку и в поисковый запрос', async () => {
    const ctx = setup(4, withClarify);
    await ctx.bot.handle(msg('нужна фанера в Москве, только от производителя'));
    let m = lastSend(ctx.sent);
    expect(m.text).toContain('Какая толщина и марка фанеры нужны?');
    expect(m.buttons.map((b) => b.text)).toEqual(['Пропустить']);
    await ctx.bot.handle(msg('18 мм, ФСФ'));
    m = lastSend(ctx.sent);
    expect(m.text).toContain('— характеристики: 18 мм, марка ФСФ;');
    await ctx.bot.handle(press('CONFIRM_QUERY', m.text));
    expect(ctx.searches.at(-1)).toMatchObject({ productId: 'plywood', regionCode: '77', interpreted: true, attributes: [{ value: 18, unit: 'мм' }, { text: 'ФСФ' }] });
  });

  it('вопрос можно пропустить, и он не повторяется', async () => {
    const ctx = setup(4, withClarify);
    await ctx.bot.handle(msg('нужна фанера в Москве, только от производителя'));
    await ctx.bot.handle(press('SKIP_ATTRIBUTES', lastSend(ctx.sent).text));
    const m = lastSend(ctx.sent);
    expect(m.text).not.toContain('толщина');
    expect(m.buttons.map((b) => b.text)).toEqual(['Подтвердить', 'Изменить параметры']);
  });

  it('характеристики уже есть в запросе — не спрашивает', async () => {
    const ctx = setup(4, withClarify);
    await ctx.bot.handle(msg('фанера ФСФ 18 мм в Москве, только от производителя'));
    expect(lastSend(ctx.sent).text).toContain('— характеристики: 18 мм, марка ФСФ;');
  });
});
