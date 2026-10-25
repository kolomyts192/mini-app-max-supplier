import type { PoolClient } from 'pg';

export interface QuarantineEntry {
  reason: string;
  inn: string | null;
  payload: string;
}

/** Сколько исходных записей хранить для разбора; счётчики причин ведутся по всем. */
const KEEP_ENTRIES = 10_000;
const PAYLOAD_LIMIT = 4000;

/**
 * Карантин одного этапа импорта: записи, которые не прошли проверку или не разобрались.
 * Импорт продолжается, причина и исходный фрагмент сохраняются для разбора.
 */
export class Quarantine {
  private readonly kept: QuarantineEntry[] = [];
  private readonly byReason = new Map<string, number>();
  private total = 0;

  constructor(readonly dataset: string) {}

  add(reason: string, inn: string | null, payload: string): void {
    this.total += 1;
    this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    if (this.kept.length < KEEP_ENTRIES) this.kept.push({ reason, inn: inn || null, payload: payload.slice(0, PAYLOAD_LIMIT) });
  }

  get count(): number {
    return this.total;
  }

  get entries(): readonly QuarantineEntry[] {
    return this.kept;
  }

  reasons(): Record<string, number> {
    return Object.fromEntries([...this.byReason.entries()].sort((a, b) => b[1] - a[1]));
  }
}

/** Хранение карантина в opendata_quarantine: при повторном импорте записи набора заменяются. */
export class QuarantineStore {
  async replace(client: PoolClient, quarantine: Quarantine): Promise<void> {
    await client.query('DELETE FROM opendata_quarantine WHERE dataset = $1', [quarantine.dataset]);
    if (!quarantine.entries.length) return;
    await client.query(
      `INSERT INTO opendata_quarantine (dataset, reason, inn, payload)
       SELECT $1, q.reason, q.inn, q.payload FROM jsonb_to_recordset($2::jsonb) AS q(reason text, inn text, payload text)`,
      [quarantine.dataset, JSON.stringify(quarantine.entries)],
    );
  }
}
