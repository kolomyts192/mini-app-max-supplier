import type { PoolClient } from 'pg';
import { RecordsetWriter } from './recordsetWriter';

/** Доходы и расходы по бухотчётности из открытых данных ФНС (в рублях). */
export interface FinancialReportRow {
  supplierId: string;
  year: number;
  revenue: number;
  expenses: number;
  sourceUrl: string;
  checkedAt: string;
}

/** Замена отчётности одного источника целиком. Отчётность ручной тестовой базы хранится под своим источником. */
export class FinancialReportWriter extends RecordsetWriter {
  async replaceSource(client: PoolClient, source: string, rows: FinancialReportRow[]): Promise<number> {
    await client.query(`DELETE FROM financial_reports WHERE source = $1 AND is_manual_test_data = false`, [source]);
    return this.insertChunks(
      client,
      `INSERT INTO financial_reports (supplier_id, period_year, revenue, expenses, unit, source, source_url, is_manual_test_data, checked_at)
       SELECT r.supplier_id, r.period_year, r.revenue, r.expenses, 'RUB', r.source, r.source_url, false, r.checked_at
         FROM jsonb_to_recordset($1::jsonb) AS r(
           supplier_id uuid, period_year int, revenue bigint, expenses bigint, source text, source_url text, checked_at timestamptz
         )`,
      rows.map((r) => ({ supplier_id: r.supplierId, period_year: r.year, revenue: r.revenue, expenses: r.expenses, source, source_url: r.sourceUrl, checked_at: r.checkedAt })),
    );
  }
}

/** Декларация или сертификат Росаккредитации, привязанные к поставщику. */
export interface ComplianceDocumentRow {
  supplierId: string;
  productId: string | null;
  type: 'DECLARATION' | 'CERTIFICATE';
  number: string;
  status: string;
  manufacturerInn: string | null;
  manufacturerName: string | null;
  applicant: string | null;
  productName: string | null;
  techRegulation: string | null;
  body: string | null;
  validFrom: string | null;
  validTo: string | null;
  sourceUrl: string;
  checkedAt: string;
}

export class ComplianceDocumentWriter extends RecordsetWriter {
  async replaceSource(client: PoolClient, source: string, rows: ComplianceDocumentRow[]): Promise<number> {
    await client.query(`DELETE FROM compliance_documents WHERE source = $1 AND is_manual_test_data = false`, [source]);
    return this.insertChunks(
      client,
      `INSERT INTO compliance_documents (supplier_id, product_id, document_type, number, status, manufacturer_inn, manufacturer_name, applicant,
         product_name, tech_regulation, certification_body, valid_from, valid_to, source, source_url, is_manual_test_data, checked_at)
       SELECT d.supplier_id, d.product_id, d.document_type, d.number, d.status, d.manufacturer_inn, d.manufacturer_name, d.applicant,
              d.product_name, d.tech_regulation, d.certification_body, d.valid_from, d.valid_to, d.source, d.source_url, false, d.checked_at
         FROM jsonb_to_recordset($1::jsonb) AS d(
           supplier_id uuid, product_id text, document_type text, number text, status text, manufacturer_inn text, manufacturer_name text,
           applicant text, product_name text, tech_regulation text, certification_body text, valid_from date, valid_to date, source text,
           source_url text, checked_at timestamptz
         )`,
      rows.map((d) => ({
        supplier_id: d.supplierId,
        product_id: d.productId,
        document_type: d.type,
        number: d.number,
        status: d.status,
        manufacturer_inn: d.manufacturerInn,
        manufacturer_name: d.manufacturerName,
        applicant: d.applicant,
        product_name: d.productName,
        tech_regulation: d.techRegulation,
        certification_body: d.body,
        valid_from: d.validFrom,
        valid_to: d.validTo,
        source,
        source_url: d.sourceUrl,
        checked_at: d.checkedAt,
      })),
    );
  }
}

/** Официальный риск-сигнал о поставщике (запись РНП и т. п.). */
export interface RiskSignalRow {
  supplierId: string;
  kind: 'RNP';
  title: string;
  details: string | null;
  recordNumber: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  checkedAt: string;
}

export class RiskSignalWriter extends RecordsetWriter {
  async replaceSource(client: PoolClient, source: string, rows: RiskSignalRow[]): Promise<number> {
    await client.query(`DELETE FROM risk_signals WHERE source = $1 AND is_manual_test_data = false`, [source]);
    return this.insertChunks(
      client,
      `INSERT INTO risk_signals (supplier_id, kind, title, details, record_number, published_at, source, source_url, is_manual_test_data, checked_at)
       SELECT r.supplier_id, r.kind, r.title, r.details, r.record_number, r.published_at, r.source, r.source_url, false, r.checked_at
         FROM jsonb_to_recordset($1::jsonb) AS r(
           supplier_id uuid, kind text, title text, details text, record_number text, published_at date, source text, source_url text, checked_at timestamptz
         )`,
      rows.map((r) => ({
        supplier_id: r.supplierId,
        kind: r.kind,
        title: r.title,
        details: r.details,
        record_number: r.recordNumber,
        published_at: r.publishedAt,
        source,
        source_url: r.sourceUrl,
        checked_at: r.checkedAt,
      })),
    );
  }
}
