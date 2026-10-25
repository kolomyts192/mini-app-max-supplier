import type { PoolClient } from 'pg';
import type { Db } from '../../infra/db';
import type { EntityScope } from './factBatchWriter';

export interface ImportLogEntry {
  dataset: string;
  source: string;
  title: string;
  dataDate: string;
  fileUrl: string;
  rowsTotal: number;
  rowsMatched: number;
  details?: object;
}

/** Журнал загруженных наборов (opendata_imports): одна строка на набор, последняя версия. */
export class ImportLog {
  constructor(private readonly db: Db | PoolClient) {}

  async record(e: ImportLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO opendata_imports (dataset, source, title, data_date, file_url, imported_at, rows_total, rows_matched, details)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8)
       ON CONFLICT (dataset) DO UPDATE SET source = EXCLUDED.source, title = EXCLUDED.title, data_date = EXCLUDED.data_date, file_url = EXCLUDED.file_url,
         imported_at = now(), rows_total = EXCLUDED.rows_total, rows_matched = EXCLUDED.rows_matched, details = EXCLUDED.details`,
      [e.dataset, e.source, e.title, e.dataDate, e.fileUrl, e.rowsTotal, e.rowsMatched, JSON.stringify(e.details ?? {})],
    );
  }
}

/** ИНН → id официальных поставщиков: наборы обогащения сопоставляются с базой по ИНН. */
export class OfficialSupplierIndex {
  private constructor(private readonly byInn: ReadonlyMap<string, string>) {}

  static async load(db: Db): Promise<OfficialSupplierIndex> {
    const { rows } = await db.query<{ inn: string; id: string }>(`SELECT inn, id FROM suppliers WHERE source_type = 'OFFICIAL'`);
    return new OfficialSupplierIndex(new Map(rows.map((r) => [r.inn, r.id])));
  }

  static of(entries: Iterable<[string, string]>): OfficialSupplierIndex {
    return new OfficialSupplierIndex(new Map(entries));
  }

  get size(): number {
    return this.byInn.size;
  }

  idOf(inn: string | undefined): string | undefined {
    return inn ? this.byInn.get(inn) : undefined;
  }

  /** Пары [ИНН, id] вида лица: у юрлица ИНН из 10 цифр, у ИП — из 12. */
  *entries(scope: EntityScope = 'ALL'): Iterable<[string, string]> {
    for (const entry of this.byInn) {
      if (scope === 'ALL' || (scope === 'LEGAL_ENTITY') === (entry[0].length === 10)) yield entry;
    }
  }
}
