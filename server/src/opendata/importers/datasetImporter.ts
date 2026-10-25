import type { ImportResult } from '../domain/importResult';

/**
 * Группа этапа: registry — основа базы (реестр МСП), enrichment — сведения к карточкам,
 * documents — декларации и сертификаты, risks — риск-сигналы.
 */
export type StageGroup = 'registry' | 'enrichment' | 'documents' | 'risks';

/** Этап импорта: один набор открытых данных. */
export interface DatasetImporter {
  readonly stage: string;
  readonly title: string;
  readonly group: StageGroup;
  run(): Promise<ImportResult>;
}

/** Строка, привязанная к поставщику по ИНН до того, как известен его id в базе. */
export type ByInn<T extends { supplierId: string }> = Omit<T, 'supplierId'> & { inn: string };

/** Привязывает строки к id поставщиков; строки без поставщика в базе отбрасываются. */
export function bindToSuppliers<T extends { supplierId: string }>(rows: ByInn<T>[], ids: ReadonlyMap<string, string>): T[] {
  const out: T[] = [];
  for (const { inn, ...rest } of rows) {
    const supplierId = ids.get(inn);
    if (supplierId) out.push({ ...rest, supplierId } as unknown as T);
  }
  return out;
}

export const secondsSince = (started: number) => Math.round((Date.now() - started) / 1000);
