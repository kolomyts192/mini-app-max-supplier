import type { PoolClient } from 'pg';
import { RecordsetWriter } from './recordsetWriter';

/** Запись о продукции поставщика из реестра МСП: по основному ОКВЭД или по заявленной продукции. */
export interface ProductWriteRow {
  supplierId: string;
  categoryId: string;
  productId: string | null;
  title: string;
  okpd2: string | null;
  origin: 'OKVED' | 'SME_DECLARED';
  source: string;
  sourceUrl: string;
  checkedAt: string;
}

/** Пакетная замена продукции поставщиков, пришедшей из реестра МСП. Записи ГИСП и тестовой базы не трогает. */
export class ProductBatchWriter extends RecordsetWriter {
  async replace(client: PoolClient, supplierIds: string[], rows: ProductWriteRow[]): Promise<number> {
    if (!supplierIds.length) return 0;
    await client.query(`DELETE FROM product_records WHERE origin IN ('OKVED', 'SME_DECLARED') AND supplier_id = ANY($1::uuid[])`, [supplierIds]);
    return this.insertChunks(
      client,
      `INSERT INTO product_records (supplier_id, category_id, product_id, title, okpd2, origin, source, source_url, is_manual_test_data, updated_at)
       SELECT p.supplier_id, p.category_id, p.product_id, p.title, p.okpd2, p.origin, p.source, p.source_url, false, p.checked_at
         FROM jsonb_to_recordset($1::jsonb) AS p(
           supplier_id uuid, category_id text, product_id text, title text, okpd2 text, origin text, source text, source_url text, checked_at timestamptz
         )`,
      rows.map((r) => ({
        supplier_id: r.supplierId,
        category_id: r.categoryId,
        product_id: r.productId,
        title: r.title,
        okpd2: r.okpd2,
        origin: r.origin,
        source: r.source,
        source_url: r.sourceUrl,
        checked_at: r.checkedAt,
      })),
    );
  }
}
