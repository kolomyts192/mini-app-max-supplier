import type { Catalog } from '../catalog/catalog';

/**
 * Сопоставление основного ОКВЭД с категориями справочника (правила okvedRules в data/catalog.json).
 * ОКВЭД даёт только совпадение по категории и «профильный вид деятельности».
 * Статус производителя по одному ОКВЭД не присваивается (раздел 16 ТЗ).
 */
interface CompiledRule {
  prefix: string;
  category: string;
  name?: RegExp;
}

const compiled = new WeakMap<Catalog, CompiledRule[]>();

function rules(catalog: Catalog): CompiledRule[] {
  let list = compiled.get(catalog);
  if (!list) {
    list = catalog.data.categories.flatMap((c) =>
      (c.okvedRules ?? []).map((r) => ({ prefix: r.prefix, category: c.id, name: r.name ? new RegExp(r.name, 'iu') : undefined })),
    );
    compiled.set(catalog, list);
  }
  return list;
}

const matchesPrefix = (code: string, prefix: string) => code === prefix || code.startsWith(`${prefix}.`);

export function categoriesForOkved(code: string | undefined, name: string | undefined, catalog: Catalog): string[] {
  if (!code) return [];
  const out = new Set<string>();
  for (const r of rules(catalog)) {
    if (!matchesPrefix(code, r.prefix)) continue;
    if (r.name && !r.name.test(name ?? '')) continue;
    out.add(r.category);
  }
  return [...out];
}

/** Быстрая проверка до полного разбора документа реестра. */
export function okvedMayMatch(code: string, catalog: Catalog): boolean {
  return rules(catalog).some((r) => matchesPrefix(code, r.prefix));
}

/** Заявленная в реестре МСП продукция (ОКПД2) → конкретные товары справочника. */
export function productsForOkpd2(code: string | undefined, catalog: Catalog): { productId: string; categoryId: string }[] {
  if (!code) return [];
  const out: { productId: string; categoryId: string }[] = [];
  for (const c of catalog.data.categories) {
    for (const p of c.products) {
      if (p.okpd2 && (code === p.okpd2 || code.startsWith(`${p.okpd2}.`))) out.push({ productId: p.id, categoryId: c.id });
    }
  }
  return out;
}

/** «НОГИНСК» → «Ногинск», «ОРЕХОВО-ЗУЕВО» → «Орехово-Зуево». */
export function titleCase(s: string | undefined | null): string | null {
  if (!s) return null;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-(«"])([а-яёa-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();
}

/**
 * Короткое наименование из реестра: прямые кавычки → «ёлочки», вложенные → „лапки“.
 * Кавычка открывающая, если стоит в начале, после пробела или после другой открывающей кавычки.
 */
export function prettyName(short: string | undefined, full: string | undefined): string {
  const raw = (short || full || '').trim().replace(/\s+/g, ' ');
  let depth = 0;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '"') {
      out += ch;
      continue;
    }
    const prev = out.at(-1) ?? ' ';
    const next = raw[i + 1] ?? ' ';
    const opening = (prev === ' ' || prev === '«' || prev === '„' || /[А-ЯA-Z]$/.test(out) && depth === 0) && next !== ' ' && next !== '"';
    if (opening && depth < 2) {
      out += depth === 0 ? '«' : '„';
      depth += 1;
    } else if (depth > 0) {
      out += depth === 2 ? '“' : '»';
      depth -= 1;
    }
  }
  while (depth > 0) {
    out += depth === 2 ? '“' : '»';
    depth -= 1;
  }
  // «ЗАО«ИМЯ»» → «ЗАО «ИМЯ»»
  return out.replace(/^(ООО|АО|ЗАО|ОАО|ПАО|НАО|ТОО)«/u, '$1 «');
}
