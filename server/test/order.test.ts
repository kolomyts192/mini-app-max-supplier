import { describe, expect, it } from 'vitest';
import type { SupplierSummary } from '../src/search/dto';
import type { SupplierRow } from '../src/search/model';
import { cloneKey, ResultOrder } from '../src/search/order';

const summary = (id: string, name: string, over: Partial<SupplierSummary> & { basis?: string } = {}): SupplierSummary =>
  ({
    id, name, score: 0.9, entityType: 'LEGAL_ENTITY', region: { code: '16', name: 'Татарстан' },
    match: { basis: over.basis ?? 'document' },
    ...over,
  }) as unknown as SupplierSummary;
const row = (id: string, over: Partial<SupplierRow> = {}): SupplierRow => ({ id, employees: null, last_revenue: null, registration_date: null, ...over }) as SupplierRow;

describe('порядок выдачи при равном балле', () => {
  it('выручка, затем сотрудники, затем более старая регистрация, а не алфавит', () => {
    const list = [summary('a', 'Альфа'), summary('b', 'Бета'), summary('c', 'Гамма'), summary('d', 'Дельта')];
    const order = new ResultOrder([
      row('a'),
      row('b', { last_revenue: 5_000_000 }),
      row('c', { employees: 40, registration_date: '2015-01-01' }),
      row('d', { employees: 40, registration_date: '2005-06-01' }),
    ]);
    expect([...list].sort(order.compare).map((s) => s.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('только по ОКВЭД — ниже подтверждённого товара, даже если у него больше выручка', () => {
    const okved = summary('o', 'Аргон', { basis: 'okved_exact' });
    const doc = summary('d', 'Яхонт', { basis: 'document' });
    const order = new ResultOrder([row('o', { last_revenue: 9e9 }), row('d')]);
    expect([okved, doc].sort(order.compare).map((s) => s.id)).toEqual(['d', 'o']);
  });

  it('балл важнее любых тай-брейков', () => {
    const order = new ResultOrder([row('a', { last_revenue: 1e9 }), row('b')]);
    expect([summary('a', 'А', { score: 0.8 }), summary('b', 'Б', { score: 0.9 })].sort(order.compare).map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('клоны в выдаче', () => {
  it('«1-ЛКЗ РУ» и «1ЛКЗ РУ» в одном регионе — одна запись, остаётся лучшая', () => {
    expect(cloneKey('ООО «1-ЛКЗ РУ»')).toBe(cloneKey('ООО «1ЛКЗ РУ»'));
    const out = ResultOrder.withoutClones([summary('1', 'ООО «1-ЛКЗ РУ»'), summary('2', 'ООО «1ЛКЗ РУ»'), summary('3', 'ООО «Другая»')]);
    expect(out.map((s) => s.id)).toEqual(['1', '3']);
  });

  it('одноимённые компании из разных регионов и ИП не склеиваются', () => {
    const out = ResultOrder.withoutClones([
      summary('1', 'ООО «Альфа»'),
      summary('2', 'ООО «Альфа»', { region: { code: '77', name: 'Москва' } }),
      summary('3', 'ИП Иванов И.И.', { entityType: 'IP' }),
      summary('4', 'ИП Иванов И.И.', { entityType: 'IP' }),
    ]);
    expect(out.map((s) => s.id)).toEqual(['1', '2', '3', '4']);
  });
});
