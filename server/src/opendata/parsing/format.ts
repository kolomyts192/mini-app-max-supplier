/** Форматирование значений из наборов ФНС для карточки: даты, суммы, названия. */

/** DD.MM.YYYY → YYYY-MM-DD */
export function isoDate(d: string | undefined): string | null {
  const m = d ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** YYYY-MM-DD → DD.MM.YYYY */
export function ruDate(iso: string): string {
  return iso.split('-').reverse().join('.');
}

export const rub = (n: number, digits = 0) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ₽`;

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

const ORG_FORMS: [RegExp, string][] = [
  [/^АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'АО '],
  [/^ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'ПАО '],
  [/^ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ\s*/i, 'ООО '],
  [/^АВТОНОМНАЯ НЕКОММЕРЧЕСКАЯ ОРГАНИЗАЦИЯ\s*/i, 'АНО '],
  [/^НЕКОММЕРЧЕСКАЯ ОРГАНИЗАЦИЯ\s*/i, 'НКО '],
  [/^ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ\s*/i, 'ГБУ '],
  [/^ГОСУДАРСТВЕННОЕ АВТОНОМНОЕ УЧРЕЖДЕНИЕ\s*/i, 'ГАУ '],
];

/** «АКЦИОНЕРНОЕ ОБЩЕСТВО «МСП БАНК»» → «АО «МСП БАНК»». */
export function shortOrgForm(name: string): string {
  for (const [re, short] of ORG_FORMS) if (re.test(name)) return name.replace(re, short);
  return name;
}

/** Короткие названия налогов для строки «крупнейшие платежи». */
export function shortTaxName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('добавленную стоимость')) return 'НДС';
  if (n.includes('налог на прибыль')) return 'налог на прибыль';
  if (n.includes('упрощенн')) return 'УСН';
  if (n.includes('сельскохозяйствен')) return 'ЕСХН';
  if (n.includes('пенсионн')) return 'пенсионные взносы';
  if (n.includes('медицинск')) return 'медицинские взносы';
  if (n.includes('временной нетрудоспособности')) return 'взносы на соцстрахование';
  if (n.includes('несчастных случаев')) return 'взносы от несчастных случаев';
  if (n.includes('страховые взносы')) return 'страховые взносы';
  if (n.includes('пеней') || n.includes('пени')) return 'пени';
  if (n.includes('имущество')) return 'налог на имущество';
  if (n.includes('транспорт')) return 'транспортный налог';
  if (n.includes('земельн')) return 'земельный налог';
  if (n.includes('неналоговые')) return 'неналоговые доходы';
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}
