import type { PoolClient } from 'pg';
import type { Db } from '../infra/db';

export interface SupplierWriteRow {
  inn: string;
  ogrn: string | null;
  name: string;
  shortName: string;
  entityType: 'LEGAL_ENTITY' | 'IP';
  regionCode: string;
  regionName: string;
  city: string | null;
  address: string;
  okvedMain: unknown;
  okvedAdditional: unknown;
  smeStatus: string;
  supplierType: string;
  supplierTypeConfidence: number;
  supplierTypeBasis: string;
  checkedAt: string;
  registrySeenAt: string;
  declaredProducts: unknown;
}

export interface ProductWriteRow {
  inn: string;
  categoryId: string;
  productId: string | null;
  title: string;
  okpd2: string | null;
  origin: 'OKVED' | 'SME_DECLARED';
  source: string;
  sourceUrl: string;
  checkedAt: string;
}

export interface FactWriteRow {
  inn: string;
  field: string;
  value: string;
  source: string;
  sourceUrl: string | null;
  sourceType: 'OFFICIAL' | 'MANUAL_TEST_DATA';
  checkedAt: string;
  freshUntil: string;
  confidence: number;
  isOfficial: boolean;
  isManual: boolean;
  notes: string | null;
}

/**
 * Пакетная запись компаний и связанных сведений одного батча.
 * Один INSERT на таблицу вместо запроса на каждую компанию: на 200 тыс. записей это разница в часы.
 */
export class SupplierBatchWriter {
  constructor(private readonly db: Db) {}

  async write(suppliers: SupplierWriteRow[], products: ProductWriteRow[], facts: FactWriteRow[]): Promise<number> {
    if (!suppliers.length) return 0;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await this.upsertSuppliers(client, suppliers);
      const inns = suppliers.map((s) => s.inn);
      await this.replaceProducts(client, inns, products);
      await this.replaceFacts(client, inns, facts);
      await client.query('COMMIT');
      return suppliers.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertSuppliers(client: PoolClient, rows: SupplierWriteRow[]): Promise<void> {
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           inn text, ogrn text, name text, short_name text, entity_type text, region_code text, region_name text,
           city text, address text, okved_main jsonb, okved_additional jsonb, sme_status text, supplier_type text,
           supplier_type_confidence numeric, supplier_type_basis text, checked_at timestamptz, registry_seen_at date,
           declared_products jsonb
         )
       )
       INSERT INTO suppliers (inn, ogrn, name, short_name, entity_type, legal_status, region_code, region_name, city, address,
         okved_main, okved_additional, sme_status, supplier_type, supplier_type_confidence, supplier_type_basis,
         source_type, is_manual_test_data, checked_at, registry_seen_at, declared_products)
       SELECT inn,
              CASE WHEN ogrn IS NOT NULL AND EXISTS (
                     SELECT 1 FROM suppliers s WHERE s.ogrn = input.ogrn AND s.inn <> input.inn
                   ) THEN NULL ELSE ogrn END,
              name, short_name, entity_type, 'ACTIVE', region_code, region_name, city, address,
              okved_main, okved_additional, sme_status, supplier_type, supplier_type_confidence, supplier_type_basis,
              'OFFICIAL', false, checked_at, registry_seen_at, declared_products
       FROM input
       ON CONFLICT (inn) DO UPDATE SET
         ogrn = COALESCE(EXCLUDED.ogrn, suppliers.ogrn), name = EXCLUDED.name, short_name = EXCLUDED.short_name,
         legal_status = 'ACTIVE', region_code = EXCLUDED.region_code, region_name = EXCLUDED.region_name,
         city = EXCLUDED.city, address = EXCLUDED.address, okved_main = EXCLUDED.okved_main,
         okved_additional = EXCLUDED.okved_additional, sme_status = EXCLUDED.sme_status,
         supplier_type = EXCLUDED.supplier_type, supplier_type_confidence = EXCLUDED.supplier_type_confidence,
         supplier_type_basis = EXCLUDED.supplier_type_basis, checked_at = EXCLUDED.checked_at,
         registry_seen_at = EXCLUDED.registry_seen_at, declared_products = EXCLUDED.declared_products, updated_at = now()
       WHERE suppliers.source_type = 'OFFICIAL'`,
      [JSON.stringify(rows)],
    );
  }

  private async replaceProducts(client: PoolClient, inns: string[], rows: ProductWriteRow[]): Promise<void> {
    await client.query(
      `DELETE FROM product_records
        WHERE origin IN ('OKVED', 'SME_DECLARED')
          AND supplier_id IN (SELECT id FROM suppliers WHERE inn = ANY($1::text[]) AND source_type = 'OFFICIAL')`,
      [inns],
    );
    if (!rows.length) return;
    await client.query(
      `INSERT INTO product_records (supplier_id, category_id, product_id, title, okpd2, origin, source, source_url, is_manual_test_data, updated_at)
       SELECT s.id, p.category_id, p.product_id, p.title, p.okpd2, p.origin, p.source, p.source_url, false, p.checked_at
         FROM jsonb_to_recordset($1::jsonb) AS p(
           inn text, category_id text, product_id text, title text, okpd2 text, origin text, source text, source_url text, checked_at timestamptz
         )
         JOIN suppliers s ON s.inn = p.inn AND s.source_type = 'OFFICIAL'`,
      [JSON.stringify(rows)],
    );
  }

  private async replaceFacts(client: PoolClient, inns: string[], rows: FactWriteRow[]): Promise<void> {
    await client.query(
      `DELETE FROM verification_records
        WHERE source = 'SME_REGISTRY'
          AND supplier_id IN (SELECT id FROM suppliers WHERE inn = ANY($1::text[]) AND source_type = 'OFFICIAL')`,
      [inns],
    );
    if (!rows.length) return;
    await client.query(
      `INSERT INTO verification_records (supplier_id, field, value, source, source_url, source_type, checked_at, fresh_until,
         confidence, is_official, is_manual_test_data, notes)
       SELECT s.id, f.field, f.value, f.source, f.source_url, f.source_type, f.checked_at, f.fresh_until,
              f.confidence, f.is_official, f.is_manual, f.notes
         FROM jsonb_to_recordset($1::jsonb) AS f(
           inn text, field text, value text, source text, source_url text, source_type text, checked_at timestamptz,
           fresh_until timestamptz, confidence numeric, is_official boolean, is_manual boolean, notes text
         )
         JOIN suppliers s ON s.inn = f.inn AND s.source_type = 'OFFICIAL'`,
      [JSON.stringify(rows)],
    );
  }
}
