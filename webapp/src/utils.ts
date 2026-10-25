export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' });
}

/** Суммы в ГИР БО хранятся в тысячах рублей. */
export function formatThousandRub(v: number | null): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млрд ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  return `${v.toLocaleString('ru-RU')} тыс. ₽`;
}

const VOWELS = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';

/**
 * Мягкие переносы для длинных слов в узких плитках: браузер переносит по слогам, а не посреди буквосочетания.
 * Упрощённое правило: граница после гласной перед «согласная + гласная», минимум два символа по краям.
 */
export function softHyphens(text: string): string {
  return text.replace(/[А-Яа-яЁё]{9,}/g, (word) => {
    let out = '';
    for (let i = 0; i < word.length; i++) {
      out += word[i];
      const isBoundary =
        i >= 1 && i < word.length - 3 && VOWELS.includes(word[i]) && !VOWELS.includes(word[i + 1]) && VOWELS.includes(word[i + 2]) && !'йЙьъ'.includes(word[i + 1]);
      if (isBoundary) out += '­';
    }
    return out;
  });
}

const SOURCE_SHORT: Record<string, string> = {
  FNS_EGRUL: 'ЕГРЮЛ',
  GISP: 'ГИСП',
  GISP_PP719: 'ГИСП',
  FSA_CERT: 'Росаккредитация',
  FSA_DECL: 'Росаккредитация',
  FAS_RNP: 'РНП',
  FEDRESURS: 'ЕФРСБ',
  GIR_BO: 'ГИР БО',
};

/** Короткие названия неподключённых реестров без повторов: «ЕГРЮЛ, ГИСП и Росаккредитация». */
export function sourcesList(ids: string[] | undefined): string {
  const names = [...new Set((ids ?? []).map((id) => SOURCE_SHORT[id] ?? id))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names.at(-1)}` : names[0] ?? '';
}

/** «Подошло 37 · проверено 150 из 1 694 · показаны 5»: сведения собираются только для лучших совпадений категории. */
export function countsLine(c: { total: number; evaluated: number; matched: number; shown: number; isEstimate: boolean }): string {
  const n = (v: number) => v.toLocaleString('ru-RU');
  const shown = c.shown === c.matched ? 'показаны все' : `показаны ${n(c.shown)}`;
  if (c.isEstimate) return `Подошло ${n(c.matched)} · проверено ${n(c.evaluated)} из ${n(c.total)} · ${shown}`;
  return c.matched === c.total ? `Подошло ${n(c.matched)} · ${shown}` : `Подошло ${n(c.matched)} из ${n(c.total)} · ${shown}`;
}

/** «Реестр МСП на 10.10.2026 · налоги на 25.09.2026»; для тестовой базы — дата проверки показанных компаний. */
export function datesLine(dates: { registryDate: string | null; factsDate: string | null }, fallback: string | null): string {
  const parts = [dates.registryDate && `Реестр МСП на ${formatDate(dates.registryDate)}`, dates.factsDate && `налоги на ${formatDate(dates.factsDate)}`].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return fallback ? `Данные на ${formatDate(fallback)}` : 'Нет данных';
}

/** Подпись характеристики: «18 мм», «толщина 18 мм», «150×150 мм», «марка ФСФ» (как на сервере). */
export function attributeLabel(a: { name: string; value: number | null; values?: number[]; unit: string | null; text: string | null }): string {
  if (a.text) return `${a.name} ${a.text}`;
  const num = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 3, useGrouping: false });
  const value = a.values?.length ? a.values.map(num).join('×') : a.value !== null ? num(a.value) : '';
  const unit = a.unit ? (a.unit === '%' ? '%' : ` ${a.unit}`) : '';
  return `${['размер', 'значение'].includes(a.name) ? '' : `${a.name} `}${value}${unit}`.trim();
}

/** Подпись об участии ИИ в выдаче; null — ИИ не подключён или не требовался. */
export function aiLine(ai: { interpretation: string; ranking: string } | undefined): string | null {
  if (!ai) return null;
  const used = (s: string) => s === 'ok' || s === 'cached';
  if (used(ai.ranking)) return 'Порядок и объяснения уточнены GigaChat по сведениям реестров';
  if (used(ai.interpretation)) return 'Запрос разобран GigaChat';
  if (ai.interpretation === 'timeout' || ai.interpretation === 'error' || ai.ranking === 'timeout' || ai.ranking === 'error') return 'GigaChat сейчас не ответил — подбор по правилам';
  return null;
}

export function suppliersWord(n: number): string {
  return plural(n, ['поставщик', 'поставщика', 'поставщиков']);
}
