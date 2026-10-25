import { soften, stem, tokenize } from '../catalog/text';
import type { Attribute } from '../domain/types';

/**
 * Характеристики товара: числа с единицами («толщиной от 4 до 30 мм», «150х150», «3,2%») и коды
 * марок и стандартов («ФСФ», «М300», «ПФ-115», «ГОСТ 3916.1-2018») — в запросе и в названиях продукции документов.
 */

/** Единицы длины сравниваются между собой в миллиметрах, остальные — только с той же единицей. */
const TO_MM: Record<string, number> = { мм: 1, см: 10, м: 1000, мкм: 0.001 };

const LABELS: [RegExp, string][] = [
  [/толщин/, 'толщина'],
  [/диаметр/, 'диаметр'],
  [/ширин/, 'ширина'],
  [/длин/, 'длина'],
  [/высот/, 'высота'],
  [/сечени/, 'сечение'],
  [/плотност/, 'плотность'],
  [/жирност/, 'жирность'],
  [/размер|формат/, 'размер'],
];

/** Подписи, которые означают «какой-то размер» и не противоречат конкретным (толщине, ширине…). */
const GENERIC_LABELS = new Set(['размер', 'значение']);

/** Характеристики длины: число без единицы у них — миллиметры. */
const LENGTH_NAMES = new Set(['толщина', 'диаметр', 'ширина', 'длина', 'высота', 'размер', 'значение']);

const NUM = String.raw`\d+(?:\.\d+)?`;
const UNIT = String.raw`(мм²|мм2|мм|см|мкм|м(?![\p{L}\p{N}²³])|%|кг/м[³3])`;
const SPAN_RE = new RegExp(
  [
    String.raw`(?<dims>${NUM}(?:\s*[xх×*]\s*${NUM}){1,2})\s*(?<dimUnit>${UNIT})?`,
    String.raw`(?:от\s*)?(?<from>${NUM})\s*(?:до|-|–|—|\.\.\.)\s*(?<to>${NUM})\s*(?<rangeUnit>${UNIT})`,
    String.raw`(?<bound>до|не более|не менее|от|свыше)\s*(?<boundValue>${NUM})\s*(?<boundUnit>${UNIT})`,
    String.raw`(?<single>${NUM})\s*(?<singleUnit>${UNIT})`,
    // «толщина 18», «диаметр 110» — размер без единицы считаем в миллиметрах
    String.raw`(?<bare>${NUM})(?=\s|$)`,
  ].join('|'),
  'giu',
);

/** Подписи размера слоя или детали: «толщина шпона», «толщиной покрытия», «облицовки». */
const COMPONENT = /шпон|покрыти|облицов|сло[яеё]|пл[её]нк|грунт|лак/u;

/** Токены, похожие на коды марок, но ими не являющиеся: единицы, регионы, формы собственности. */
const NOT_CODES = new Set(['мм', 'см', 'мкм', 'кг', 'шт', 'т', 'тн', 'л', 'мл', 'м2', 'м3', 'мск', 'спб', 'рф', 'ооо', 'ип', 'зао', 'оао', 'пао', 'ао', 'тк', 'нн', 'кв', 'км']);

export interface NumericSpan {
  label: string | null;
  unit: string;
  min: number;
  max: number;
  /** Размеры через «х»: «1525х1525». */
  values: number[];
  /** Фрагмент исходного текста с подписью: «толщиной от 4 до 30 мм». */
  text: string;
}

const unitOf = (u: string | undefined) => {
  const v = (u ?? '').toLowerCase();
  if (v === 'мм2') return 'мм²';
  if (v.startsWith('кг/м')) return 'кг/м³';
  return v || 'мм';
};

/** Десятичная запятая в выгрузках Росаккредитации иногда превращается в пробел: «2 0 мм», «от 0 4 до 0 8 мм». */
const decimals = (s: string) =>
  s.replace(/(\d),(\d)/g, '$1.$2').replace(/(?<![\d.])(\d{1,3}) (\d)(?![\d.])(?=\s*(?:мм|см|мкм|%|до(?!\p{L})|-|–|—))/giu, '$1.$2');

export class AttributeExtractor {
  /** Числовые характеристики с единицами. Объём поставки (т, кг, л, шт.) характеристикой не считается. */
  numbers(text: string | null | undefined): NumericSpan[] {
    if (!text) return [];
    const t = decimals(soften(text));
    const out: NumericSpan[] = [];
    for (const m of t.matchAll(SPAN_RE)) {
      const g = m.groups!;
      const at = m.index ?? 0;
      const before = t.slice(Math.max(0, at - 40), at);
      const labelMatch = LABELS.map(([re, label]) => ({ label, pos: before.search(new RegExp(`${re.source}\\S*\\s*(?:\\S+\\s*){0,2}$`, 'u')) })).filter((x) => x.pos >= 0).sort((a, b) => b.pos - a.pos)[0];
      const label = labelMatch?.label ?? null;
      // «толщина шпона», «толщина покрытия» — размер слоя, а не изделия
      if (labelMatch && COMPONENT.test(t.slice(Math.max(0, at - 40) + labelMatch.pos, at))) continue;
      const start = labelMatch ? Math.max(0, at - 40) + labelMatch.pos : at;
      const span = (min: number, max: number, unit: string, values: number[] = []): NumericSpan => ({ label, unit, min, max, values, text: t.slice(start, at + m[0].length).trim() });
      if (g.dims) {
        const values = g.dims.split(/\s*[xх×*]\s*/u).map(Number);
        out.push(span(Math.min(...values), Math.max(...values), unitOf(g.dimUnit), values));
      } else if (g.from) out.push(span(Number(g.from), Number(g.to), unitOf(g.rangeUnit)));
      else if (g.bound) {
        // «от 0,6 мм» без верхней границы ничего не подтверждает; «до 19 мм» — диапазон от нуля
        const v = Number(g.boundValue);
        if (g.bound === 'до' || g.bound === 'не более') out.push(span(0, v, unitOf(g.boundUnit)));
      } else if (g.single) {
        const v = Number(g.single);
        out.push(span(v, v, unitOf(g.singleUnit)));
      } else if (g.bare && label && label !== 'плотность' && label !== 'жирность') {
        const v = Number(g.bare);
        out.push(span(v, v, 'мм'));
      }
    }
    return out;
  }

  /** Коды марок и стандартов: «ФСФ», «М300», «А500С», «ПФ-115», «ГОСТ 3916.1-2018». */
  codes(text: string | null | undefined, exclude: (token: string) => boolean = () => false): string[] {
    if (!text) return [];
    const out = new Set<string>();
    for (const m of text.matchAll(/ГОСТ\s*(?:Р\s*)?\d+(?:\.\d+)*(?:-\d{2,4})?/giu)) out.add(m[0].replace(/\s+/g, ' ').replace(/^гост/i, 'ГОСТ'));
    const rest = text.replace(/ГОСТ\s*(?:Р\s*)?\d+(?:\.\d+)*(?:-\d{2,4})?/giu, ' ');
    for (const raw of rest.split(/[\s,;:()«»"]+/u)) {
      const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const lower = token.toLowerCase().replace(/ё/g, 'е');
      if (token.length < 2 || token.length > 10 || NOT_CODES.has(lower) || exclude(lower)) continue;
      const hasLetter = /\p{L}/u.test(token);
      const mixed = hasLetter && /\d/.test(token) && /^\p{L}/u.test(token);
      const consonants = /^[бвгджзйклмнпрстфхцчшщ]{2,5}$/u.test(lower);
      const upper = /^\p{Lu}{2,}/u.test(token);
      if (mixed || consonants || upper) out.add(/\p{Lu}/u.test(token) ? token : token.toUpperCase());
    }
    return [...out];
  }

  /** Характеристики из текста запроса. exclude — слова товара («ОСБ», «ПВХ»): это не марка, а сам товар. */
  fromQuery(text: string, exclude: (token: string) => boolean = () => false): Attribute[] {
    const attrs: Attribute[] = [];
    for (const s of this.numbers(text)) {
      const name = s.label ?? (s.unit === '%' ? 'доля' : s.unit === 'мм²' ? 'сечение' : s.unit === 'кг/м³' ? 'плотность' : 'размер');
      if (s.values.length) attrs.push({ name, value: null, values: s.values, unit: s.unit, text: null });
      else if (Number.isFinite(s.min) && s.min === s.max) attrs.push({ name, value: s.min, values: [], unit: s.unit, text: null });
    }
    for (const code of this.codes(text, exclude)) attrs.push({ name: /^ГОСТ/u.test(code) ? 'стандарт' : 'марка', value: null, values: [], unit: null, text: code });
    return attrs.slice(0, 6);
  }
}

/** Подпись характеристики для выдачи: «18 мм», «толщина 18 мм», «150×150 мм», «марка ФСФ». */
export function attributeLabel(a: Attribute): string {
  if (a.text) return `${a.name} ${a.text}`;
  const num = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 3, useGrouping: false });
  const value = a.values.length ? a.values.map(num).join('×') : a.value !== null ? num(a.value) : '';
  const unit = a.unit ? (a.unit === '%' ? '%' : ` ${a.unit}`) : '';
  return `${GENERIC_LABELS.has(a.name) ? '' : `${a.name} `}${value}${unit}`.trim();
}

/** Текст, в котором ищется подтверждение характеристики. relevant — документ или сведение о нужном товаре. */
export interface EvidenceText {
  text: string;
  source: 'document' | 'declared' | 'okved';
  /** Номер документа или код ОКВЭД. */
  ref: string;
  relevant: boolean;
}

export type AttributeStatus = 'confirmed' | 'mismatch' | 'unknown';

export interface AttributeCheck {
  attribute: Attribute;
  label: string;
  status: AttributeStatus;
  /** Фрагмент доказательства: «толщиной от 4 до 30 мм». */
  quote: string | null;
  ref: string | null;
  source: EvidenceText['source'] | null;
}

const EPS = 1e-6;
const codeKey = (s: string) => s.toUpperCase().replace(/Ё/g, 'Е').replace(/[\s.\-]/g, '');

/**
 * Сверка характеристик запроса с доказательствами. Подтверждение — только по тексту источника, который
 * сохраняется цитатой; «противоречит» — только если в документе о том же товаре указано другое значение той же
 * характеристики. Отсутствие сведений компанию не исключает.
 */
export class AttributeMatcher {
  constructor(private readonly extractor = new AttributeExtractor()) {}

  check(attributes: Attribute[], evidence: EvidenceText[]): AttributeCheck[] {
    const ordered = [...evidence].sort((a, b) => Number(b.relevant) - Number(a.relevant));
    const spans = new Map(ordered.map((e) => [e, this.extractor.numbers(e.text)]));
    return attributes.map((a) => (a.text ? this.checkText(a, ordered) : this.checkNumber(a, ordered, spans)));
  }

  private checkNumber(a: Attribute, evidence: EvidenceText[], spans: Map<EvidenceText, NumericSpan[]>): AttributeCheck {
    const result = (status: AttributeStatus, e?: EvidenceText, s?: NumericSpan): AttributeCheck => ({
      attribute: a, label: attributeLabel(a), status, quote: s?.text ?? null, ref: e?.ref ?? null, source: e?.source ?? null,
    });
    const unit = a.unit ?? (LENGTH_NAMES.has(a.name) ? 'мм' : null);
    if (!unit) return result('unknown');
    const wanted = (a.values.length ? a.values : a.value !== null ? [a.value] : []).map((v) => this.toBase(v, unit));
    if (!wanted.length) return result('unknown');
    const specific = !GENERIC_LABELS.has(a.name);
    let conflict: { e: EvidenceText; s: NumericSpan } | null = null;
    for (const e of evidence) {
      for (const s of spans.get(e) ?? []) {
        if (!this.sameDimension(unit, s.unit)) continue;
        if (specific && s.label && s.label !== a.name) continue;
        if (this.contains(s, wanted)) return result('confirmed', e, s);
        if (specific && s.label === a.name && e.relevant) conflict ??= { e, s };
      }
    }
    return conflict ? result('mismatch', conflict.e, conflict.s) : result('unknown');
  }

  private checkText(a: Attribute, evidence: EvidenceText[]): AttributeCheck {
    const text = a.text!;
    const isCode = /\d/.test(text) || /^\p{Lu}{2,}/u.test(text) || /^ГОСТ/iu.test(text);
    for (const e of evidence) {
      const quote = isCode ? this.findCode(text, e.text) : this.findWords(text, e.text);
      if (quote) return { attribute: a, label: attributeLabel(a), status: 'confirmed', quote, ref: e.ref, source: e.source };
    }
    return { attribute: a, label: attributeLabel(a), status: 'unknown', quote: null, ref: null, source: null };
  }

  /** «ФСФ» находится в «ФСФ-ТВ», «ПФ-115» — в «ПФ 115», но «ФК» не находится в «ФКМ». */
  private findCode(code: string, text: string): string | null {
    if (/^ГОСТ/iu.test(code)) {
      const num = code.replace(/^ГОСТ\s*(Р\s*)?/iu, '').split('-')[0];
      const m = new RegExp(`ГОСТ\\s*(?:Р\\s*)?${num.replace(/\./g, '\\.')}(?:[-\\s]\\d{2,4})?`, 'iu').exec(text);
      return m ? m[0] : null;
    }
    const key = codeKey(code);
    for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.\-]*(?:\s\d+)?/gu)) {
      const token = m[0];
      if (codeKey(token) === key || codeKey(token.split('-')[0]) === key) return token;
    }
    return null;
  }

  /** Все слова характеристики («высший сорт») встречаются в тексте. */
  private findWords(words: string, text: string): string | null {
    const wanted = tokenize(words).map(stem);
    const have = new Set(tokenize(text).map(stem));
    return wanted.length && wanted.every((w) => have.has(w)) ? words : null;
  }

  private sameDimension(a: string, b: string): boolean {
    return a === b || (a in TO_MM && b in TO_MM);
  }

  private toBase(v: number, unit: string): number {
    return v * (TO_MM[unit] ?? 1);
  }

  private contains(s: NumericSpan, wanted: number[]): boolean {
    const k = TO_MM[s.unit] ?? 1;
    if (wanted.length > 1) return s.values.length >= wanted.length && wanted.every((w) => s.values.some((v) => Math.abs(v * k - w) <= EPS));
    const w = wanted[0];
    if (s.values.length) return s.values.some((v) => Math.abs(v * k - w) <= EPS);
    return s.min * k - EPS <= w && w <= s.max * k + EPS;
  }
}
