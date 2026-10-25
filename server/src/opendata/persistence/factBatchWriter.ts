import type { PoolClient } from 'pg';
import type { EntityType } from '../domain/company';
import type { SupplierFact } from '../domain/fact';
import { RecordsetWriter } from './recordsetWriter';

/** Каких поставщиков касается набор: при замене удаляются сведения только этой части базы. */
export type EntityScope = EntityType | 'ALL';

/** Пакетная запись официальных сведений (verification_records). Сведения ручной тестовой базы не трогает. */
export class FactBatchWriter extends RecordsetWriter {
  /** Заменяет сведения источника у поставщиков батча (реестр МСП: статус, ОКВЭД, регион, категория МСП…). */
  async replaceForSuppliers(client: PoolClient, source: string, supplierIds: string[], facts: SupplierFact[]): Promise<number> {
    if (!supplierIds.length) return 0;
    await client.query(`DELETE FROM verification_records WHERE source = $1 AND supplier_id = ANY($2::uuid[]) AND is_manual_test_data = false`, [source, supplierIds]);
    return this.insert(client, facts);
  }

  /** Заменяет все сведения одного поля и источника — так повторный импорт набора не создаёт дублей. */
  async replaceField(client: PoolClient, target: { field: string; source: string; scope: EntityScope }, facts: SupplierFact[]): Promise<number> {
    await client.query(
      `DELETE FROM verification_records v
        WHERE v.field = $1 AND v.source = $2 AND v.is_manual_test_data = false
          AND ($3 = 'ALL' OR EXISTS (SELECT 1 FROM suppliers s WHERE s.id = v.supplier_id AND s.entity_type = $3))`,
      [target.field, target.source, target.scope],
    );
    return this.insert(client, facts);
  }

  private insert(client: PoolClient, facts: SupplierFact[]): Promise<number> {
    return this.insertChunks(
      client,
      `INSERT INTO verification_records (supplier_id, field, value, source, source_url, source_type, checked_at, fresh_until,
         confidence, is_official, is_manual_test_data, notes)
       SELECT f.supplier_id, f.field, f.value, f.source, f.source_url, 'OFFICIAL', f.checked_at, f.fresh_until, f.confidence, true, false, f.notes
         FROM jsonb_to_recordset($1::jsonb) AS f(
           supplier_id uuid, field text, value text, source text, source_url text, checked_at timestamptz, fresh_until timestamptz,
           confidence numeric, notes text
         )`,
      facts.map((f) => ({
        supplier_id: f.supplierId,
        field: f.field,
        value: f.value,
        source: f.source,
        source_url: f.sourceUrl,
        checked_at: f.checkedAt,
        fresh_until: f.freshUntil,
        confidence: f.confidence,
        notes: f.notes,
      })),
    );
  }
}
