/** Сведение о компании для verification_records. */
export interface FactValue {
  value: string;
  notes: string | null;
}

/** Факт, привязанный к поставщику, с датой и источником версии набора. */
export interface SupplierFact extends FactValue {
  supplierId: string;
  field: string;
  source: string;
  sourceUrl: string | null;
  /** ISO-время, на которое получены сведения (дата набора). */
  checkedAt: string;
  freshUntil: string;
  confidence: number;
}

/** Дата набора YYYY-MM-DD → момент проверки и срок свежести сведений. */
export function freshness(dataDate: string, freshDays: number): { checkedAt: string; freshUntil: string } {
  const checkedAt = `${dataDate}T00:00:00Z`;
  const until = new Date(checkedAt);
  until.setUTCDate(until.getUTCDate() + freshDays);
  return { checkedAt, freshUntil: until.toISOString() };
}
