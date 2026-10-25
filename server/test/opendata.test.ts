import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { categoriesForOkved, productsForOkpd2 } from '../src/opendata/parsing/classify';
import { PaytaxParser, SupportParser, SupportSummary } from '../src/opendata/parsing/fnsParsers';
import { prettyName, shortOrgForm, shortTaxName, titleCase } from '../src/opendata/parsing/format';
import { RsmpParser, SupplierTypeAssessor } from '../src/opendata/parsing/rsmpParser';
import { parseAttrs, streamElements, tagAttrs } from '../src/opendata/io/xmlStream';
import { catalog } from './helpers';

const parser = new RsmpParser(catalog);
const parseRsmpDoc = (doc: string, regions: Set<string> | null = null) => new RsmpParser(catalog, regions).parse(doc).company;
const supplierType = (c: Parameters<SupplierTypeAssessor['assess']>[0]) => new SupplierTypeAssessor().assess(c);

// Фрагменты в формате реального набора ФНС 7707329152-rsmp (структура 12.05.2026)
const PAINT_ORG = `<Документ ИдДок="1" ДатаСост="10.09.2026" ДатаВклМСП="10.08.2016" ВидСубМСП="1" КатСубМСП="2" ПризНовМСП="2" СведСоцПред="2">
<ОргВклМСП НаимОрг="АКЦИОНЕРНОЕ ОБЩЕСТВО &quot;ТЕСТХИМ&quot;" НаимОргСокр="АО &quot;ТЕСТХИМ&quot;" ИННЮЛ="5031000000"/>
<СведМН КодРегион="50"><Регион Тип="область" Наим="Московская"/><Город Тип="г." Наим="СТАРАЯ КУПАВНА"/></СведМН>
<СвОКВЭД><СвОКВЭДОсн КодОКВЭД="20.30.2" НаимОКВЭД="Производство прочих красок, лаков, эмалей" ВерсОКВЭД="2014"/>
<СвОКВЭДДоп КодОКВЭД="46.75" НаимОКВЭД="Торговля оптовая химическими продуктами" ВерсОКВЭД="2014"/></СвОКВЭД></Документ>`;

const AD_AGENCY_IP = `<Документ ИдДок="2" ДатаСост="10.09.2026" ДатаВклМСП="10.02.2018" ВидСубМСП="2" КатСубМСП="1"><ИПВклМСП ИННФЛ="253910730844" ОГРНИП="318253600000105"><ФИОИП Фамилия="ИВАНОВА" Имя="ОЛЬГА" Отчество="ПЕТРОВНА"/></ИПВклМСП><СведМН КодРегион="25"><Регион Тип="край" Наим="Приморский"/></СведМН><СвОКВЭД><СвОКВЭДОсн КодОКВЭД="73.11" НаимОКВЭД="Деятельность рекламных агентств" ВерсОКВЭД="2014"/></СвОКВЭД></Документ>`;

const DECLARED = `<Документ ИдДок="3" ДатаСост="10.09.2026" ДатаВклМСП="10.08.2019" ВидСубМСП="1" КатСубМСП="1"><ОргВклМСП НаимОрг="ООО &quot;КРЕП&quot;" НаимОргСокр="ООО &quot;КРЕП&quot;" ИННЮЛ="7100000000"/><СведМН КодРегион="71"/><СвОКВЭД><СвОКВЭДОсн КодОКВЭД="46.74" НаимОКВЭД="Торговля оптовая скобяными изделиями" ВерсОКВЭД="2014"/></СвОКВЭД><СвПрод КодПрод="25.94.11.110" НаимПрод="Болты и винты из черных металлов" ПрОтнПрод="0"/></Документ>`;

const INSULATION_WIDE = `<Документ ИдДок="4" ДатаСост="10.09.2026" КатСубМСП="3"><ОргВклМСП НаимОрг="ООО &quot;МИН&quot;" ИННЮЛ="5000000001"/><СведМН КодРегион="50"/><СвОКВЭД><СвОКВЭДОсн КодОКВЭД="23.99" НаимОКВЭД="Производство прочей неметаллической минеральной продукции, не включенной в другие группировки"/></СвОКВЭД></Документ>`;

describe('xml', () => {
  it('разбирает атрибуты и сущности', () => {
    expect(parseAttrs(' НаимОрг="ООО &quot;А&amp;Б&quot;" ИННЮЛ="1"')).toEqual({ НаимОрг: 'ООО "А&Б"', ИННЮЛ: '1' });
    expect(tagAttrs(PAINT_ORG, 'СвОКВЭДОсн')?.КодОКВЭД).toBe('20.30.2');
    expect(tagAttrs(PAINT_ORG, 'СвОКВЭД')).toEqual({});
  });

  it('потоково выделяет документы, разрезанные по границам чанков', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Файл>${PAINT_ORG}${AD_AGENCY_IP}${DECLARED}</Файл>`;
    const buf = Buffer.from(xml, 'utf8');
    const chunks = [buf.subarray(0, 37), buf.subarray(37, 500), buf.subarray(500)];
    const docs: string[] = [];
    const n = await streamElements(Readable.from(chunks), 'Документ', (d) => {
      docs.push(d);
    });
    expect(n).toBe(3);
    expect(docs[1]).toContain('ИННФЛ="253910730844"');
  });
});

describe('реестр МСП → поставщики', () => {
  it('производитель красок по основному ОКВЭД попадает в категорию, но тип не определён', () => {
    const c = parseRsmpDoc(PAINT_ORG)!;
    expect(c).toMatchObject({ inn: '5031000000', name: 'АО «ТЕСТХИМ»', entityType: 'LEGAL_ENTITY', sme: 'SMALL', regionCode: '50', regionName: 'Московская область', city: 'Старая Купавна' });
    expect(c.categories).toEqual(['paints']);
    expect(c.matchedBy).toEqual({ okved: ['paints'], declared: [] });
    expect(supplierType(c).type).toBe('UNKNOWN');
    expect(supplierType(c).basis).toContain('Одного ОКВЭД недостаточно');
  });

  it('компании вне товарной вертикали отбрасываются', () => {
    expect(parseRsmpDoc(AD_AGENCY_IP)).toBeNull();
    expect(parser.parse(AD_AGENCY_IP).skip).toBe('category');
  });

  it('заявленная продукция (ОКПД2) даёт совпадение по товару и статус «производитель по заявлению»', () => {
    const c = parseRsmpDoc(DECLARED)!;
    expect(c.categories).toEqual(['fasteners']);
    expect(c.matchedBy).toEqual({ okved: [], declared: ['fasteners'] });
    expect(c.products.map((p) => p.productId)).toEqual(expect.arrayContaining(['screws', 'bolts_nuts', 'anchors']));
    const t = supplierType(c);
    expect(t.type).toBe('MANUFACTURER');
    expect(t.basis).toContain('заявлены самой компанией');
  });

  it('широкий ОКВЭД 23.99 без уточнения в названии не относится к категории', () => {
    expect(parseRsmpDoc(INSULATION_WIDE)).toBeNull();
  });

  it('фильтр регионов', () => {
    expect(parseRsmpDoc(PAINT_ORG, new Set(['77']))).toBeNull();
    expect(new RsmpParser(catalog, new Set(['77'])).parse(PAINT_ORG).skip).toBe('region');
    expect(parseRsmpDoc(PAINT_ORG, new Set(['50']))).not.toBeNull();
  });

  it('классификация ОКВЭД по коду и наименованию', () => {
    expect(categoriesForOkved('23.99.6', 'Производство минеральных тепло- и звукоизоляционных материалов и изделий', catalog)).toEqual(['insulation']);
    expect(categoriesForOkved('23.64', 'Производство сухих бетонных смесей', catalog)).toEqual(['dry_mixes']);
    expect(categoriesForOkved('25.94', 'Производство крепежных изделий', catalog)).toEqual(['fasteners']);
    expect(categoriesForOkved('46.73', 'Торговля оптовая', catalog)).toEqual([]);
    expect(productsForOkpd2('20.30.11.120', catalog).map((p) => p.productId)).toEqual(['paint_construction', 'paint_facade', 'paint_interior']);
  });

  it('оформление названий', () => {
    expect(titleCase('ОРЕХОВО-ЗУЕВО')).toBe('Орехово-Зуево');
    expect(prettyName('ООО "ЛАКОКРАСКА"', undefined)).toBe('ООО «ЛАКОКРАСКА»');
    expect(prettyName('ООО "УЗТК "ТЕПЛОКОМПЛЕКТ""', undefined)).toBe('ООО «УЗТК „ТЕПЛОКОМПЛЕКТ“»');
    expect(prettyName('ЗАО"ПОДОЛЬСКИЙ ЗАВОД СТРОЙМАТЕРИАЛОВ"', undefined)).toBe('ЗАО «ПОДОЛЬСКИЙ ЗАВОД СТРОЙМАТЕРИАЛОВ»');
    expect(prettyName('ООО "УЗТК "ТЕПЛОКОМПЛЕКТ"', undefined)).toBe('ООО «УЗТК „ТЕПЛОКОМПЛЕКТ“»');
  });
});

// Фрагменты реальных наборов ФНС: 7707329152-paytax, 7707329152-rsmppp
const PAYTAX = `<Документ ИдДок="1" ДатаДок="01.04.2026" ДатаСост="31.12.2025"><СведНП НаимОрг="ООО &quot;ЛЕНКОМ&quot;" ИННЮЛ="7802670891"/><СвУплСумНал НаимНалог="Налог на добавленную стоимость" СумУплНал="2282495.00"/><СвУплСумНал НаимНалог="Налог на прибыль" СумУплНал="600659.00"/><СвУплСумНал НаимНалог="Страховые и другие взносы на обязательное пенсионное страхование, зачисляемые в Пенсионный фонд Российской Федерации" СумУплНал="352342.48"/><СвУплСумНал НаимНалог="Суммы пеней" СумУплНал="0.00"/></Документ>`;

const SUPPORT = `<Документ ИдДок="2" ДатаСост="15.09.2026"><СвЮЛ НаимОрг="ООО &quot;КРЕП&quot;" ИННЮЛ="7100000000" ОГРН="1027100000000"/><СвПредПод НомерПод="1" ДатаСвед="15.11.2021" ВидПП="1" НаимОрг="ФОНД ПОДДЕРЖКИ ПРЕДПРИНИМАТЕЛЬСТВА" ИННЮЛ="3808187490" КатСуб="1" СрокПод="15.10.2021" ДатаПрин="15.10.2021" ИнфНаруш="2"><ФормПод КодФорм="0300" НаимФорм="Образовательная поддержка"/><ВидПод КодВид="0302" НаимВид="Семинары"/><РазмПод РазмПод="1.00" ЕдПод="3"/></СвПредПод><СвПредПод НомерПод="2" ДатаСвед="15.07.2025" ВидПП="1" НаимОрг="АКЦИОНЕРНОЕ ОБЩЕСТВО &quot;МСП БАНК&quot;" ИННЮЛ="7703213534" КатСуб="1" СрокПод="31.03.2026" ДатаПрин="04.04.2025" ИнфНаруш="1"><ФормПод КодФорм="0100" НаимФорм="Финансовая поддержка"/><ВидПод КодВид="0103" НаимВид="Предоставление субсидий и грантов"/><РазмПод РазмПод="350000.00" ЕдПод="1"/></СвПредПод></Документ>`;

describe('наборы «Прозрачного бизнеса» и реестр поддержки МСП', () => {
  it('уплаченные налоги: итог за год и крупнейшие платежи', () => {
    const f = new PaytaxParser().parse(PAYTAX);
    expect(f.value.replace(/\s/g, ' ')).toBe('3 235 496 ₽ за 2025 год');
    expect(f.notes).toMatch(/^Крупнейшие платежи: НДС — 2\s282\s495 ₽; налог на прибыль — 600\s659 ₽; пенсионные взносы — 352\s342 ₽$/);
    expect(shortTaxName('Суммы пеней')).toBe('пени');
  });

  it('поддержка МСП: число мер, деньги только в рублях, нарушение условий, последняя мера', () => {
    const s = new SupportSummary().add(new SupportParser().parse(SUPPORT)!);
    expect(s).toMatchObject({ count: 2, rub: 350000, violation: true });
    expect(s.last).toMatchObject({ date: '2025-04-04', form: 'Финансовая поддержка', provider: 'АО «МСП БАНК»', amount: 350000 });
    const f = s.toFact();
    expect(f.value.replace(/\s/g, ' ')).toBe('2 меры поддержки; 350 000 ₽ в денежном выражении; есть сведения о нарушении порядка и условий поддержки');
    expect(f.notes).toContain('04.04.2025');
    expect(new SupportParser().innOf(SUPPORT)).toBe('7100000000');
    expect(shortOrgForm('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «А»')).toBe('ООО «А»');
  });
});
