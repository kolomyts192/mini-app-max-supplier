import { FsaParser } from './fsaParser';

export interface RnpColumns {
  inn: number;
  number: number;
  date: number;
  reason: number;
}

export interface RnpRecord {
  inn: string;
  number: string | null;
  /** Дата включения в реестр, YYYY-MM-DD. */
  includedAt: string | null;
  reason: string | null;
}

/** Строки CSV реестра недобросовестных поставщиков ФАС (7703516539-rnp). Колонки определяются по заголовку. */
export class RnpParser {
  columns(header: string[]): RnpColumns {
    const h = header.map((x) => x.toLowerCase());
    const col = (re: RegExp) => h.findIndex((x) => re.test(x));
    const cols = { inn: col(/инн/), number: col(/номер|реестров/), date: col(/дата.*(включ|внесен|публикац)/), reason: col(/основани|причин/) };
    if (cols.inn < 0) throw new Error(`В наборе РНП не найдена колонка ИНН: ${header.join(' | ')}`);
    return cols;
  }

  row(cells: string[], c: RnpColumns): RnpRecord | null {
    const inn = (cells[c.inn] ?? '').replace(/\D/g, '');
    if (inn.length !== 10 && inn.length !== 12) return null;
    const at = (i: number) => (i >= 0 && cells[i] ? cells[i] : null);
    return { inn, number: at(c.number), includedAt: FsaParser.parseDate(at(c.date) ?? undefined), reason: at(c.reason) };
  }
}
