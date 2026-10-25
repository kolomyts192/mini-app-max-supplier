import { describe, expect, it } from 'vitest';
import { withDocumentManufacturer } from '../src/search/manufacturer';
import type { SupplierRow } from '../src/search/model';
import type { DocumentRow } from '../src/sources/types';

const supplier = (over: Partial<SupplierRow> = {}) => ({ id: 's', inn: '7608008662', supplier_type: 'UNKNOWN', supplier_type_confidence: 0.3, supplier_type_basis: 'основной ОКВЭД', is_manual_test_data: false, ...over }) as SupplierRow;
const doc = (over: Partial<DocumentRow> = {}) => ({ inn: '7608008662', document_type: 'CERTIFICATE', number: 'RU С-RU.ПБ09.В.00677/25', status: 'ACTIVE', manufacturer_inn: '7608008662', ...over }) as DocumentRow;

describe('производитель по документу', () => {
  it('изготовитель в действующем сертификате — сама компания: тип «производитель», основание с номером', () => {
    const s = withDocumentManufacturer(supplier(), { certs: [doc()], decls: null });
    expect(s.supplier_type).toBe('MANUFACTURER');
    expect(s.supplier_type_basis).toBe('компания указана изготовителем в сертификате RU С-RU.ПБ09.В.00677/25 (Росаккредитация)');
  });

  it('декларация тоже подходит; действующий документ предпочтительнее архивного', () => {
    const s = withDocumentManufacturer(supplier(), { certs: [doc({ status: 'ARCHIVED' })], decls: [doc({ document_type: 'DECLARATION', number: 'ЕАЭС N RU Д-RU.1' })] });
    expect(s.supplier_type_basis).toContain('в декларации ЕАЭС N RU Д-RU.1');
    expect(s.supplier_type_confidence).toBe(0.9);
  });

  it('архивный документ — производитель с пометкой и меньшей уверенностью', () => {
    const s = withDocumentManufacturer(supplier(), { certs: [doc({ status: 'ARCHIVED' })], decls: null });
    expect(s.supplier_type).toBe('MANUFACTURER');
    expect(s.supplier_type_basis).toContain('срок документа истёк');
    expect(s.supplier_type_confidence).toBe(0.75);
  });

  it('не меняет: чужой изготовитель, прекращённый документ, ручную тестовую базу', () => {
    expect(withDocumentManufacturer(supplier(), { certs: [doc({ manufacturer_inn: '1111111111' })], decls: null }).supplier_type).toBe('UNKNOWN');
    expect(withDocumentManufacturer(supplier(), { certs: [doc({ status: 'TERMINATED' })], decls: null }).supplier_type).toBe('UNKNOWN');
    expect(withDocumentManufacturer(supplier({ is_manual_test_data: true }), { certs: [doc()], decls: null }).supplier_type).toBe('UNKNOWN');
    expect(withDocumentManufacturer(supplier(), undefined).supplier_type).toBe('UNKNOWN');
  });

  it('уже определённый тип «производитель» не трогаем: основание из реестра МСП остаётся', () => {
    const s = supplier({ supplier_type: 'MANUFACTURER', supplier_type_basis: 'в реестре МСП компания указала производимую продукцию' });
    expect(withDocumentManufacturer(s, { certs: [doc()], decls: null })).toBe(s);
  });
});
