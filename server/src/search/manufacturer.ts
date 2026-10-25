import type { DocumentRow } from '../sources/types';
import type { Evidence, SupplierRow } from './model';

const KIND = { CERTIFICATE: 'сертификате', DECLARATION: 'декларации' } as const;

/**
 * Если в сертификате или декларации Росаккредитации изготовителем указана сама компания (по ИНН), она производитель:
 * это документ, а не догадка по ОКВЭД. Основание — тип и номер документа. Действующий документ предпочтительнее
 * архивного; приостановленные и прекращённые не учитываем. Ручная тестовая база и уже определённые типы не меняются.
 */
export function withDocumentManufacturer(s: SupplierRow, ev: Pick<Evidence, 'certs' | 'decls'> | undefined): SupplierRow {
  if (s.is_manual_test_data || s.supplier_type === 'MANUFACTURER') return s;
  const docs: DocumentRow[] = [...(ev?.certs ?? []), ...(ev?.decls ?? [])].filter((d) => d.manufacturer_inn === s.inn);
  const doc = docs.find((d) => d.status === 'ACTIVE') ?? docs.find((d) => d.status === 'ARCHIVED');
  if (!doc) return s;
  const note = doc.status === 'ARCHIVED' ? ', срок документа истёк' : '';
  return {
    ...s,
    supplier_type: 'MANUFACTURER',
    supplier_type_confidence: doc.status === 'ACTIVE' ? 0.9 : 0.75,
    supplier_type_basis: `компания указана изготовителем в ${KIND[doc.document_type]} ${doc.number} (Росаккредитация${note})`,
  };
}
