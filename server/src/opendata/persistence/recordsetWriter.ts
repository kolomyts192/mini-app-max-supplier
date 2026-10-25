import type { PoolClient } from 'pg';

/**
 * Основа пакетных писателей: строки передаются одним параметром jsonb и разворачиваются
 * через jsonb_to_recordset — один запрос на тысячи строк вместо INSERT на каждую.
 */
export abstract class RecordsetWriter {
  constructor(protected readonly chunkSize = 5000) {}

  /** sql принимает массив записей параметром $1::jsonb. */
  protected async insertChunks(client: PoolClient, sql: string, records: object[]): Promise<number> {
    for (let i = 0; i < records.length; i += this.chunkSize) {
      await client.query(sql, [JSON.stringify(records.slice(i, i + this.chunkSize))]);
    }
    return records.length;
  }
}
