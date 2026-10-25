import type { PoolClient } from 'pg';
import type { EntityType, Okved, DeclaredProduct } from '../domain/company';

/** Поставщик из реестра МСП в виде строки таблицы suppliers. */
export interface SupplierWriteRow {
  inn: string;
  ogrn: string | null;
  name: string;
  shortName: string;
  entityType: EntityType;
  regionCode: string;
  regionName: string;
  city: string | null;
  address: string;
  okvedMain: Okved;
  okvedAdditional: Okved[];
  smeStatus: string;
  supplierType: string;
  supplierTypeConfidence: number;
  supplierTypeBasis: string;
  checkedAt: string;
  registrySeenAt: string;
  declaredProducts: DeclaredProduct[];
}

export interface PreparedSuppliers {
  rows: SupplierWriteRow[];
  /** Повторы ИНН внутри батча: остаётся последняя запись. */
  duplicateInn: number;
  /** ОГРН, уже встреченный у другого ИНН внутри батча: у повтора ОГРН не записывается. */
  ogrnConflicts: number;
}

/**
 * Пакетный upsert поставщиков: один запрос на батч, id возвращаются тем же запросом.
 * Ручная тестовая база не перезаписывается; ОГРН, занятый другим ИНН, не записывается (уникальный индекс).
 */
export class SupplierBatchWriter {
  /** Готовит батч к одному INSERT … ON CONFLICT: PostgreSQL не позволяет обновить одну строку дважды за запрос. */
  static prepare(rows: SupplierWriteRow[]): PreparedSuppliers {
    const byInn = new Map<string, SupplierWriteRow>();
    for (const r of rows) byInn.set(r.inn, r);
    const ogrnOwner = new Map<string, string>();
    let ogrnConflicts = 0;
    const prepared = [...byInn.values()].map((r) => {
      if (!r.ogrn) return r;
      const owner = ogrnOwner.get(r.ogrn);
      if (owner && owner !== r.inn) {
        ogrnConflicts += 1;
        return { ...r, ogrn: null };
      }
      ogrnOwner.set(r.ogrn, r.inn);
      return r;
    });
    return { rows: prepared, duplicateInn: rows.length - byInn.size, ogrnConflicts };
  }

  /** Возвращает id поставщиков по ИНН. Строки должны пройти prepare(). */
  async upsert(client: PoolClient, rows: SupplierWriteRow[]): Promise<Map<string, string>> {
    if (!rows.length) return new Map();
    const { rows: written } = await client.query<{ inn: string; id: string }>(
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
              CASE WHEN ogrn IS NOT NULL AND EXISTS (SELECT 1 FROM suppliers s WHERE s.ogrn = input.ogrn AND s.inn <> input.inn)
                   THEN NULL ELSE ogrn END,
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
       WHERE suppliers.source_type = 'OFFICIAL'
       RETURNING inn, id`,
      [JSON.stringify(rows.map(SupplierBatchWriter.record))],
    );
    return new Map(written.map((r) => [r.inn, r.id]));
  }

  /**
   * Поставщики, которых нет в новой версии реестра: в реестр МСП входят только действующие субъекты,
   * поэтому статус «действует» больше не подтверждается. regions — только для импорта по части регионов.
   */
  async markNotSeen(client: PoolClient, dataDate: string, regions: ReadonlySet<string> | null): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE suppliers SET legal_status = 'UNKNOWN', updated_at = now()
        WHERE source_type = 'OFFICIAL' AND (registry_seen_at IS NULL OR registry_seen_at < $1) AND legal_status <> 'UNKNOWN'
          AND ($2::text[] IS NULL OR region_code = ANY($2::text[]))`,
      [dataDate, regions ? [...regions] : null],
    );
    return rowCount ?? 0;
  }

  private static record(r: SupplierWriteRow) {
    return {
      inn: r.inn,
      ogrn: r.ogrn,
      name: r.name,
      short_name: r.shortName,
      entity_type: r.entityType,
      region_code: r.regionCode,
      region_name: r.regionName,
      city: r.city,
      address: r.address,
      okved_main: r.okvedMain,
      okved_additional: r.okvedAdditional,
      sme_status: r.smeStatus,
      supplier_type: r.supplierType,
      supplier_type_confidence: r.supplierTypeConfidence,
      supplier_type_basis: r.supplierTypeBasis,
      checked_at: r.checkedAt,
      registry_seen_at: r.registrySeenAt,
      declared_products: r.declaredProducts,
    };
  }
}
