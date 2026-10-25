import type { Db } from '../infra/db';
import type { Logger } from '../logger';
import { type DadataClient, DadataLimitError, type DadataParty } from '../sources/dadata';

const EGRUL_URL = 'https://egrul.nalog.ru/';

export const EGRUL_STATE_LABEL: Record<string, string> = {
  ACTIVE: 'действующая',
  REORGANIZING: 'в процессе реорганизации',
  LIQUIDATING: 'в стадии ликвидации',
  BANKRUPT: 'банкротство',
  LIQUIDATED: 'деятельность прекращена',
};

export interface EgrulVerification {
  field: string;
  value: string;
  notes: string | null;
}

export interface EgrulRisk {
  kind: 'BANKRUPTCY' | 'UNRELIABLE_INFO' | 'LIQUIDATION';
  title: string;
  details: string;
  publishedAt: string | null;
}

export interface EgrulRecord {
  verifications: EgrulVerification[];
  risks: EgrulRisk[];
  patch: { ogrn: string | null; kpp: string | null; registrationDate: string | null; director: string | null; inactive: boolean };
}

const day = (ms: number | null | undefined) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
const ru = (iso: string | null) => (iso ? iso.split('-').reverse().join('.') : null);
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** Ответ DaData → поля ЕГРЮЛ и официальные риск-сигналы (без оценок надёжности). */
export function mapParty(p: DadataParty): EgrulRecord {
  const status = p.state?.status ?? 'ACTIVE';
  const actual = ru(day(p.state?.actuality_date));
  const notes = `ЕГРЮЛ/ЕГРИП по API DaData${actual ? `, сведения на ${actual}` : ''}`;
  const registrationDate = day(p.state?.registration_date) ?? day(p.ogrn_date);
  const person = [p.fio?.surname, p.fio?.name, p.fio?.patronymic].filter(Boolean).join(' ');
  const director = p.management?.name
    ? `${p.management.post ? `${sentence(p.management.post)} — ` : ''}${p.management.name}`
    : p.type === 'INDIVIDUAL' && person
      ? person
      : null;
  const address = p.address?.unrestricted_value || p.address?.value || null;
  const inactive = status === 'LIQUIDATED';

  const v: EgrulVerification[] = [
    { field: 'legal_status', value: inactive ? 'INACTIVE' : 'ACTIVE', notes },
    { field: 'egrul_state', value: status, notes: EGRUL_STATE_LABEL[status] ?? status },
  ];
  if (p.ogrn) v.push({ field: 'ogrn', value: p.ogrn, notes });
  if (registrationDate) v.push({ field: 'registration_date', value: registrationDate, notes });
  if (director) v.push({ field: 'director', value: director, notes });
  // Адрес ИП в открытом доступе не раскрывается — показываем только адрес организации
  if (address && p.type !== 'INDIVIDUAL') v.push({ field: 'address', value: address, notes });
  if (p.okved) v.push({ field: 'okved_main', value: p.okved, notes });
  const extra = (p.okveds ?? []).filter((o) => !o.main && o.code).map((o) => o.code);
  if (extra.length) v.push({ field: 'okved_additional', value: extra.join(','), notes });

  const risks: EgrulRisk[] = [];
  if (status === 'BANKRUPT') {
    risks.push({ kind: 'BANKRUPTCY', title: 'Банкротство по данным ЕГРЮЛ', details: 'В ЕГРЮЛ внесены сведения о банкротстве юридического лица.', publishedAt: null });
  }
  if (status === 'LIQUIDATING') {
    risks.push({ kind: 'LIQUIDATION', title: 'Компания в стадии ликвидации', details: 'В ЕГРЮЛ внесено решение о ликвидации юридического лица.', publishedAt: null });
  }
  const inv = p.address?.invalidity;
  if (p.invalid || inv) {
    const why = inv?.code === 'COURT' ? 'по решению суда' : inv?.code === 'FNS' ? 'по результатам проверки ФНС' : null;
    const what = inv ? 'адрес' : 'сведения';
    risks.push({
      kind: 'UNRELIABLE_INFO',
      title: 'Недостоверность сведений в ЕГРЮЛ',
      details: `В ЕГРЮЛ есть запись о недостоверности: ${what}${why ? ` ${why}` : ''}${inv?.description ? ` (${inv.description})` : ''}.`,
      publishedAt: day(inv?.decision?.date),
    });
  }

  return { verifications: v, risks, patch: { ogrn: p.ogrn ?? null, kpp: p.kpp ?? null, registrationDate, director, inactive } };
}

export interface EgrulOptions {
  /** Через сколько дней сведения ЕГРЮЛ запрашиваются заново. */
  maxAgeDays: number;
  concurrency?: number;
}

/**
 * ЕГРЮЛ для реальных компаний: запрашивается только для компаний в выдаче и открытых карточек,
 * результат хранится в verification_records / risk_signals (source = FNS_EGRUL) и читается адаптером ЕГРЮЛ.
 */
export class EgrulService {
  private pausedUntil = 0;
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly db: Db,
    private readonly client: DadataClient | null,
    private readonly log: Logger,
    private readonly opts: EgrulOptions,
  ) {}

  get enabled(): boolean {
    return !!this.client;
  }

  /**
   * Обновляет сведения по ИНН, у которых их нет или они старше maxAgeDays.
   * deadlineMs ограничивает ожидание: запросы, не успевшие к сроку, завершаются в фоне и пригодятся в следующий раз.
   */
  async refresh(inns: string[], opts: { deadlineMs?: number } = {}): Promise<{ refreshed: string[]; failed: number }> {
    if (!this.client || !inns.length || Date.now() < this.pausedUntil) return { refreshed: [], failed: 0 };
    const { rows } = await this.db.query<{ id: string; inn: string }>(
      `SELECT s.id, s.inn FROM suppliers s
        WHERE s.inn = ANY($1) AND s.source_type = 'OFFICIAL'
          AND NOT EXISTS (SELECT 1 FROM verification_records v
                           WHERE v.supplier_id = s.id AND v.source = 'FNS_EGRUL' AND v.field IN ('legal_status', 'egrul_not_found')
                             AND v.checked_at > now() - make_interval(days => $2))`,
      [inns, this.opts.maxAgeDays],
    );
    if (!rows.length) return { refreshed: [], failed: 0 };

    const refreshed: string[] = [];
    let failed = 0;
    const queue = [...rows];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const ok = await this.fetchOne(r.id, r.inn);
        if (ok) refreshed.push(r.inn);
        else failed += 1;
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 5, rows.length) }, worker));
    if (opts.deadlineMs) await Promise.race([all, new Promise((r) => setTimeout(r, opts.deadlineMs))]);
    else await all;
    return { refreshed: [...refreshed], failed };
  }

  private fetchOne(supplierId: string, inn: string): Promise<boolean> {
    const running = this.inFlight.get(inn);
    if (running) return running;
    const p = this.load(supplierId, inn).finally(() => this.inFlight.delete(inn));
    this.inFlight.set(inn, p);
    return p;
  }

  private async load(supplierId: string, inn: string): Promise<boolean> {
    if (Date.now() < this.pausedUntil) return false;
    try {
      const party = await this.client!.findParty(inn);
      await this.save(supplierId, party ? mapParty(party) : null);
      return true;
    } catch (err) {
      if (err instanceof DadataLimitError) this.pausedUntil = Date.now() + 3600_000;
      this.log.warn({ source: 'FNS_EGRUL', err: (err as Error).message }, 'egrul refresh failed');
      return false;
    }
  }

  private async save(supplierId: string, rec: EgrulRecord | null): Promise<void> {
    const client = await this.db.connect();
    const now = new Date();
    const fresh = new Date(now.getTime() + 14 * 86_400_000).toISOString();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM verification_records WHERE supplier_id = $1 AND source = 'FNS_EGRUL' AND is_manual_test_data = false`, [supplierId]);
      await client.query(`DELETE FROM risk_signals WHERE supplier_id = $1 AND source = 'FNS_EGRUL' AND is_manual_test_data = false`, [supplierId]);
      const verifications = rec?.verifications ?? [{ field: 'egrul_not_found', value: 'true', notes: 'Запись по ИНН в ЕГРЮЛ/ЕГРИП не найдена (API DaData)' }];
      for (const v of verifications) {
        await client.query(
          `INSERT INTO verification_records (supplier_id, field, value, source, source_url, source_type, checked_at, fresh_until, confidence, is_official, is_manual_test_data, notes)
           VALUES ($1, $2, $3, 'FNS_EGRUL', $4, 'OFFICIAL', $5, $6, 0.95, true, false, $7)`,
          [supplierId, v.field, v.value, EGRUL_URL, now.toISOString(), fresh, v.notes],
        );
      }
      for (const r of rec?.risks ?? []) {
        await client.query(
          `INSERT INTO risk_signals (supplier_id, kind, title, details, published_at, source, source_url, is_manual_test_data, checked_at)
           VALUES ($1, $2, $3, $4, $5, 'FNS_EGRUL', $6, false, $7)`,
          [supplierId, r.kind, r.title, r.details, r.publishedAt, EGRUL_URL, now.toISOString()],
        );
      }
      if (rec) {
        const p = rec.patch;
        await client.query(
          `UPDATE suppliers SET
             ogrn = CASE WHEN $2::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers o WHERE o.ogrn = $2 AND o.id <> $1) THEN $2 ELSE ogrn END,
             kpp = COALESCE($3, kpp), registration_date = COALESCE($4::date, registration_date), director = COALESCE($5, director),
             legal_status = CASE WHEN $6 THEN 'INACTIVE' ELSE legal_status END, updated_at = now()
           WHERE id = $1 AND source_type = 'OFFICIAL'`,
          [supplierId, p.ogrn, p.kpp, p.registrationDate, p.director, p.inactive],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
