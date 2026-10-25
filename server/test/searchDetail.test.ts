import { describe, expect, it } from 'vitest';
import { searchQuerySchema, type SearchQuery } from '../src/domain/types';
import { AttributeExtractor, AttributeMatcher, attributeLabel, type EvidenceText } from '../src/search/attributes';
import { deriveFacts } from '../src/search/facts';
import { applyInterpretation, RuleQueryInterpreter } from '../src/search/interpretation';
import { productMatchScore } from '../src/search/ranking';
import { TermMatcher } from '../src/search/terms';
import type { DocumentRow } from '../src/sources/types';
import { catalog, evidence, NOW, supplier } from './helpers';

const x = new AttributeExtractor();
const doc = (text: string, i = 0): EvidenceText => ({ text, source: 'document', ref: `D${i}`, relevant: true });

describe('характеристики в тексте документов', () => {
  it('диапазоны, верхняя граница, десятичная запятая, превращённая в пробел', () => {
    const spans = (t: string) => x.numbers(t).map((s) => [s.label, s.min, s.max, s.unit]);
    expect(spans('Панели из фанеры ФСФ-ТВ толщиной от 4 до 30 мм облицованные')).toEqual([['толщина', 4, 30, 'мм']]);
    expect(spans('общей толщиной до 19 мм')).toEqual([['толщина', 0, 19, 'мм']]);
    expect(spans('Двери с облицовкой из досок толщиной от 0 4 до 0 8 мм')[0].slice(1, 3)).toEqual([0.4, 0.8]);
    expect(spans('Плиты толщиной 2 0 мм')).toEqual([['толщина', 2, 2, 'мм']]);
  });

  it('открытая нижняя граница и толщина шпона или покрытия ничего не подтверждают', () => {
    expect(x.numbers('панели толщина шпона от 0,6 мм')).toEqual([]);
    expect(x.numbers('изделия толщиной покрытия 2 мм')).toEqual([]);
  });

  it('размеры через «х» и коды марок', () => {
    expect(x.numbers('Поддоны 1200х800 мм')[0]).toMatchObject({ values: [1200, 800], unit: 'мм' });
    expect(x.codes('Фанера ФСФ, бетон М300, арматура А500С, эмаль ПФ-115, ГОСТ 3916.1-2018, ООО в СПБ')).toEqual(['ГОСТ 3916.1-2018', 'ФСФ', 'М300', 'А500С', 'ПФ-115']);
  });
});

describe('характеристики в запросе', () => {
  const rules = new RuleQueryInterpreter(catalog);
  const labels = (text: string) => rules.interpretSync(text).attributes.map(attributeLabel);

  it('размеры, марки, стандарты; слова товара — не марка; объём партии — не характеристика', () => {
    expect(labels('фанера ФСФ влагостойкая 21 мм')).toEqual(['21 мм', 'марка ФСФ']);
    expect(labels('фанера фсф толщина 18')).toEqual(['толщина 18 мм', 'марка ФСФ']);
    expect(labels('брус 150х150')).toEqual(['150×150 мм']);
    expect(labels('ОСБ плита 12 мм')).toEqual(['12 мм']);
    expect(labels('пластиковые окна ПВХ')).toEqual([]);
    expect(labels('бетон М300, 20 кубов')).toEqual(['марка М300']);
    expect(labels('фанера ГОСТ 3916.1-2018')).toEqual(['стандарт ГОСТ 3916.1-2018']);
  });

  it('разбор дополняет запрос, но не перетирает выбранное пользователем', () => {
    const q = searchQuerySchema.parse({ text: 'фанера 18 мм, Москва', regionCode: '50' });
    const out = applyInterpretation(q, rules.interpretSync(q.text));
    expect(out).toMatchObject({ productId: 'plywood', categoryId: 'lumber', regionCode: '50', interpreted: true });
    expect(out.attributes.map(attributeLabel)).toEqual(['18 мм']);
  });
});

describe('сверка характеристик с доказательствами', () => {
  const m = new AttributeMatcher();
  const check = (query: string, texts: string[]) => m.check(new RuleQueryInterpreter(catalog).interpretSync(query).attributes, texts.map(doc)).map((c) => [c.label, c.status, c.quote]);

  it('значение в диапазоне документа — подтверждено цитатой', () => {
    expect(check('фанера 18 мм', ['Фанера толщиной от 4 до 30 мм'])).toEqual([['18 мм', 'confirmed', 'толщиной от 4 до 30 мм']]);
  });

  it('та же характеристика с другим значением в документе о товаре — противоречит', () => {
    expect(check('фанера толщиной 35 мм', ['Фанера толщиной от 4 до 30 мм'])).toEqual([['толщина 35 мм', 'mismatch', 'толщиной от 4 до 30 мм']]);
  });

  it('сведений нет — «не указано», а не противоречие', () => {
    expect(check('фанера 18 мм', ['Фанера общего назначения'])).toEqual([['18 мм', 'unknown', null]]);
  });

  it('марка: ФСФ находится в «ФСФ-ТВ», ФК — не в «ФКМ», ПФ-115 — в «ПФ 115»', () => {
    expect(check('фанера ФСФ', ['фанера ФСФ-ТВ'])).toEqual([['марка ФСФ', 'confirmed', 'ФСФ-ТВ']]);
    expect(check('фанера ФК', ['фанера марки ФКМ'])).toEqual([['марка ФК', 'unknown', null]]);
    expect(check('эмаль ПФ-115', ['Эмаль ПФ 115 белая'])[0][1]).toBe('confirmed');
  });
});

describe('слова товара для поиска по документам', () => {
  it('берутся слова, которые написал пользователь, а не все синонимы товара', () => {
    const q = (text: string) => searchQuerySchema.parse({ text, productId: 'dairy' });
    expect(TermMatcher.forQuery(q('молоко 3,2%'), catalog).terms).toEqual(['молоко']);
    expect(TermMatcher.forQuery(q(''), catalog).terms.length).toBeGreaterThan(3);
  });

  it('слово в начале названия — сам товар, в конце — материал', () => {
    const t = new TermMatcher(['фанера']);
    expect(t.find('Фанера общего назначения')?.head).toBe(true);
    expect(t.find('Панели декоративные стеновые на основе фанеры')?.head).toBe(false);
  });
});

describe('основание совпадения по товару', () => {
  const q: SearchQuery = searchQuerySchema.parse({ text: 'фанера 18 мм', productId: 'plywood', categoryId: 'lumber', attributes: [{ name: 'размер', value: 18, unit: 'мм' }], interpreted: true });
  const row = (over: Partial<DocumentRow>): DocumentRow => ({ ...evidence().decls![0], product_id: 'plywood', ...over });
  const PLYWOOD = { code: '16.21.11', name: 'Производство фанеры, деревянных фанерованных панелей' };
  const facts = (products: Parameters<typeof supplier>[0]['products'], docs: DocumentRow[] = [], okved = PLYWOOD) =>
    deriveFacts(supplier({ products, okved_main: okved }), evidence({ decls: docs }), q, catalog, NOW, true);

  it('документ на сам товар сильнее ОКВЭД; характеристика подтверждена — без скидки', () => {
    const f = facts([{ product_id: 'plywood', category_id: 'lumber', title: 'ОКВЭД', origin: 'OKVED', characteristics: { exact: true } }], [row({ product_name: 'Фанера ФСФ толщиной от 4 до 30 мм' })]);
    expect(f.productBasis).toBe('document');
    expect(f.attributeChecks[0].status).toBe('confirmed');
    expect(productMatchScore(f, q)).toBe(1);
  });

  it('документ на изделие из товара слабее документа на сам товар', () => {
    const f = facts([], [row({ product_name: 'Панели стеновые на основе фанеры толщиной от 4 до 30 мм' })]);
    expect(f.productBasis).toBe('document');
    expect(f.productEvidence?.head).toBe(false);
    expect(productMatchScore(f, q)).toBe(0.9);
  });

  it('только ОКВЭД, называющий товар; толщина не указана — скидка 10 %', () => {
    const f = facts([{ product_id: 'plywood', category_id: 'lumber', title: 'ОКВЭД', origin: 'OKVED', characteristics: { exact: true } }]);
    expect(f.productBasis).toBe('okved_exact');
    expect(f.productEvidence?.named).toBe(true);
    expect(productMatchScore(f, q)).toBe(0.855);
  });

  it('слово товара в названии основного вида деятельности — слабее ОКВЭД товара', () => {
    const f = facts([{ product_id: null, category_id: 'lumber', title: 'ОКВЭД', origin: 'OKVED' }]);
    expect(f.productBasis).toBe('okved_text');
    expect(productMatchScore(f, q)).toBe(0.63);
  });

  it('только категория', () => {
    const f = facts([{ product_id: null, category_id: 'lumber', title: 'ОКВЭД', origin: 'OKVED' }], [], { code: '16.10', name: 'Распиловка и строгание древесины' });
    expect(f.productBasis).toBe('category');
    expect(f.productMatch).toBe('category');
    expect(productMatchScore(f, q)).toBe(0.54);
  });
});
