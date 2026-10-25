import type { Catalog } from '../catalog/catalog';
import { normalize, stem, tokenize } from '../catalog/text';
import type { SearchQuery } from '../domain/types';

const stemsMatch = (want: string, have: string) => want === have || (want.length >= 4 && have.startsWith(want) && have.length - want.length <= 3);

/**
 * Слова товара из запроса: название и синонимы товара справочника плюс термины из разбора запроса.
 * Ищутся в названиях продукции документов и в названиях видов деятельности — как полнотекстовый индекс в БД.
 */
export class TermMatcher {
  private readonly stems: { term: string; stems: string[] }[];

  constructor(readonly terms: string[]) {
    this.stems = terms.map((term) => ({ term, stems: tokenize(term).map(stem) })).filter((t) => t.stems.length);
  }

  /**
   * Слова, которые пользователь действительно написал («молоко», а не все синонимы товара вплоть до «сыр»),
   * плюс термины разбора. Если ни один синоним в тексте не встретился (товар выбран из подсказки) —
   * название и синонимы товара.
   */
  static forQuery(q: Pick<SearchQuery, 'productId' | 'terms' | 'text'>, catalog: Catalog): TermMatcher {
    const product = catalog.product(q.productId);
    const all = product ? [product.name, ...product.synonyms] : [];
    const used = q.text ? all.filter((t) => new TermMatcher([t]).find(q.text)) : [];
    const terms = [...(used.length ? used : all.slice(0, 7)), ...(q.terms ?? [])];
    return new TermMatcher([...new Map(terms.map((t) => [normalize(t), t])).values()]);
  }

  get empty(): boolean {
    return this.stems.length === 0;
  }

  /**
   * Подошедший термин и фрагмент текста вокруг него — для цитаты в объяснении. head — термин в начале названия
   * («Фанера общего назначения…»): это сам товар, а не материал («Панели… на основе фанеры»).
   */
  find(text: string | null | undefined): { term: string; quote: string; head: boolean } | null {
    if (!text || this.empty) return null;
    const words = tokenize(text);
    const have = words.map(stem);
    let best: { term: string; at: number } | null = null;
    for (const t of this.stems) {
      const at = t.stems.map((s) => have.findIndex((h) => stemsMatch(s, h)));
      if (at.some((i) => i < 0)) continue;
      const first = Math.min(...at);
      if (!best || first < best.at) best = { term: t.term, at: first };
    }
    return best ? { term: best.term, quote: TermMatcher.snippet(text, words[best.at]), head: best.at <= 2 } : null;
  }

  /** Фрагмент вокруг слова, не длиннее 160 символов. */
  static snippet(text: string, word: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    const pos = Math.max(0, clean.toLowerCase().replace(/ё/g, 'е').indexOf(word));
    const start = Math.max(0, pos - 50);
    const end = Math.min(clean.length, start + 160);
    return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
  }
}
