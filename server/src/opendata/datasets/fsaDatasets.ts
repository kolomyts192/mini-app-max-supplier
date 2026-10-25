import fs from 'node:fs';
import path from 'node:path';
import { forEachZipEntry } from '../io/xmlStream';
import type { SevenZip } from '../io/sevenZip';

export type FsaKind = 'rds' | 'rss';

/** Набор открытых данных Росаккредитации: декларации (rds) или сертификаты (rss). */
export class FsaDataset {
  constructor(
    readonly kind: FsaKind,
    readonly source: 'FSA_DECL' | 'FSA_CERT',
    readonly type: 'DECLARATION' | 'CERTIFICATE',
    readonly title: string,
    readonly passport: string,
  ) {}

  get stage(): string {
    return `fsa-${this.kind}`;
  }

  /**
   * Папка с архивами: <dir>/fsa-<вид> (том opendata в Docker) или <dir>/fsa/<вид> (скачано через браузер).
   * Если нет ни одной — первая из них, туда и скачивается свежий архив.
   */
  folder(dir: string): string {
    const candidates = [path.join(dir, this.stage), path.join(dir, 'fsa', this.kind)];
    return candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
  }
}

export const FSA: Record<FsaKind, FsaDataset> = {
  rds: new FsaDataset('rds', 'FSA_DECL', 'DECLARATION', 'Реестр деклараций о соответствии', 'https://fsa.gov.ru/opendata/7736638268-rds/'),
  rss: new FsaDataset('rss', 'FSA_CERT', 'CERTIFICATE', 'Реестр сертификатов соответствия', 'https://fsa.gov.ru/opendata/7736638268-rss/'),
};

/** Один месячный CSV: внутри архива или отдельным файлом. */
export interface FsaSource {
  archive: string;
  /** Файл внутри архива; null — сам файл является CSV. */
  entry: string | null;
  /** Начало периода среза (YYYYMMDD) — для порядка обработки. */
  period: string;
}

export interface FsaArchives {
  sources: FsaSource[];
  archives: string[];
  /** Дата самого свежего архива, YYYY-MM-DD. */
  dataDate: string | null;
}

/**
 * Архивы набора в папке: 7z/zip с помесячными CSV внутри или отдельные CSV. Росаккредитация публикует архивы
 * с перекрывающимися периодами — одинаковый месячный CSV берётся из самого нового архива.
 */
export class FsaArchiveSet {
  constructor(
    private readonly folder: string,
    private readonly sevenZip: () => SevenZip,
  ) {}

  /** Первая дата в имени файла → YYYYMMDD. Встречаются оба формата: rss_20240601-20240630.csv и rss_01062025-30062025.csv. */
  static dateIn(name: string): string {
    for (const m of name.matchAll(/(?<!\d)(\d{8})(?!\d)/g)) {
      const s = m[1];
      if (/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)) return s;
      if (/^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])20\d{2}$/.test(s)) return `${s.slice(4)}${s.slice(2, 4)}${s.slice(0, 2)}`;
    }
    return '00000000';
  }

  async discover(): Promise<FsaArchives> {
    const archives = fs.existsSync(this.folder)
      ? fs.readdirSync(this.folder).filter((f) => /\.(7z|zip|csv)$/i.test(f)).sort((a, b) => FsaArchiveSet.dateIn(a).localeCompare(FsaArchiveSet.dateIn(b)))
      : [];
    const byEntry = new Map<string, FsaSource>();
    for (const name of archives) {
      const file = path.join(this.folder, name);
      // Архивы отсортированы от старых к новым: более новый архив перезаписывает тот же месяц
      for (const entry of await this.entries(file)) {
        const key = entry ? path.basename(entry).toLowerCase() : name;
        byEntry.set(key, { archive: file, entry, period: FsaArchiveSet.dateIn(entry ? path.basename(entry) : name) });
      }
    }
    const last = archives.at(-1);
    const d = last ? FsaArchiveSet.dateIn(last) : null;
    return {
      sources: [...byEntry.values()].sort((a, b) => a.period.localeCompare(b.period)),
      archives,
      dataDate: d && d !== '00000000' ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    };
  }

  private async entries(file: string): Promise<(string | null)[]> {
    if (/\.7z$/i.test(file)) return (await this.sevenZip().list(file)).filter((e) => /\.csv$/i.test(e));
    if (!/\.zip$/i.test(file)) return [null];
    const out: string[] = [];
    await forEachZipEntry(file, async (e, s) => {
      out.push(e);
      s.resume();
    }, /\.csv$/i);
    return out;
  }
}
