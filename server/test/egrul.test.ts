import { describe, expect, it, vi } from 'vitest';
import { mapParty } from '../src/services/egrul';
import { DadataClient, DadataLimitError, type DadataParty } from '../src/sources/dadata';

const base: DadataParty = {
  inn: '7707083893',
  kpp: '773601001',
  ogrn: '1027700132195',
  type: 'LEGAL',
  state: { status: 'ACTIVE', actuality_date: Date.UTC(2026, 8, 1), registration_date: Date.UTC(1991, 5, 20) },
  management: { name: 'Иванов Иван Иванович', post: 'ГЕНЕРАЛЬНЫЙ ДИРЕКТОР' },
  address: { value: 'г Москва, ул Вавилова, д 19', unrestricted_value: '117312, г Москва, ул Вавилова, д 19' },
  okved: '64.19',
  okveds: [
    { code: '64.19', main: true },
    { code: '66.19', main: false },
  ],
  invalid: false,
};

describe('ЕГРЮЛ: ответ DaData → поля и риск-сигналы', () => {
  it('действующая компания: статус, ОГРН, дата регистрации, руководитель, адрес, ОКВЭД', () => {
    const r = mapParty(base);
    const v = Object.fromEntries(r.verifications.map((x) => [x.field, x.value]));
    expect(v).toMatchObject({
      legal_status: 'ACTIVE',
      egrul_state: 'ACTIVE',
      ogrn: '1027700132195',
      registration_date: '1991-06-20',
      director: 'Генеральный директор — Иванов Иван Иванович',
      address: '117312, г Москва, ул Вавилова, д 19',
      okved_main: '64.19',
      okved_additional: '66.19',
    });
    expect(r.risks).toEqual([]);
    expect(r.patch.inactive).toBe(false);
    expect(r.verifications[0].notes).toContain('01.09.2026');
  });

  it('ликвидированная компания получает статус INACTIVE (исключается жёстким фильтром)', () => {
    const r = mapParty({ ...base, state: { ...base.state, status: 'LIQUIDATED' } });
    expect(r.verifications.find((x) => x.field === 'legal_status')?.value).toBe('INACTIVE');
    expect(r.patch.inactive).toBe(true);
  });

  it('ликвидация, банкротство и недостоверность — отдельные официальные факты', () => {
    expect(mapParty({ ...base, state: { status: 'LIQUIDATING' } }).risks.map((x) => x.kind)).toEqual(['LIQUIDATION']);
    expect(mapParty({ ...base, state: { status: 'BANKRUPT' } }).risks.map((x) => x.kind)).toEqual(['BANKRUPTCY']);
    const inv = mapParty({ ...base, invalid: true, address: { ...base.address, invalidity: { code: 'FNS' } } });
    expect(inv.risks).toHaveLength(1);
    expect(inv.risks[0]).toMatchObject({ kind: 'UNRELIABLE_INFO' });
    expect(inv.risks[0].details).toContain('адрес по результатам проверки ФНС');
  });

  it('ИП: руководитель — ФИО, адрес не сохраняется', () => {
    const r = mapParty({ inn: '500100732259', type: 'INDIVIDUAL', ogrn: '304500116000157', fio: { surname: 'Петров', name: 'Пётр', patronymic: 'Петрович' }, state: { status: 'ACTIVE' }, address: { value: 'Московская обл' } });
    const v = Object.fromEntries(r.verifications.map((x) => [x.field, x.value]));
    expect(v.director).toBe('Петров Пётр Петрович');
    expect(v.address).toBeUndefined();
  });
});

describe('DadataClient', () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('ищет основную организацию по ИНН с ключом в заголовке Authorization', async () => {
    const fetchImpl = reply(200, { suggestions: [{ value: 'ПАО', data: base }] });
    const client = new DadataClient({ apiKey: 'test-key-123', fetchImpl: fetchImpl as unknown as typeof fetch });
    const party = await client.findParty('7707083893');
    expect(party?.ogrn).toBe('1027700132195');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/findById\/party$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Token test-key-123');
    expect(JSON.parse(init.body as string)).toMatchObject({ query: '7707083893', branch_type: 'MAIN' });
  });

  it('пустой ответ — компания не найдена', async () => {
    const client = new DadataClient({ apiKey: 'test-key-123', fetchImpl: reply(200, { suggestions: [] }) as unknown as typeof fetch });
    expect(await client.findParty('0000000000')).toBeNull();
  });

  it('403/429 — исчерпан лимит: отдельная ошибка, чтобы приостановить запросы', async () => {
    const client = new DadataClient({ apiKey: 'test-key-123', fetchImpl: reply(403, {}) as unknown as typeof fetch });
    await expect(client.findParty('7707083893')).rejects.toBeInstanceOf(DadataLimitError);
  });
});
