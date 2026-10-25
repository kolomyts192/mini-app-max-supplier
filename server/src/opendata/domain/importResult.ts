export type StageStatus = 'ok' | 'skipped' | 'failed';

/** Итог одного этапа импорта (одного набора данных). */
export interface ImportResult {
  stage: string;
  title: string;
  status: StageStatus;
  /** Дата версии набора, YYYY-MM-DD. */
  dataDate: string | null;
  /** Записей в наборе. */
  rowsTotal: number;
  /** Записей, относящихся к поставщикам базы. */
  rowsMatched: number;
  /** Записей, сохранённых в БД (компаний, фактов, документов — по смыслу набора). */
  written: number;
  /** Записей, отправленных в карантин с причиной. */
  quarantined: number;
  elapsedSec: number;
  details: Record<string, unknown>;
  /** Причина пропуска или текст ошибки. */
  message?: string;
}

/** Результат этапа, который не выполнялся: набор не скачан или источник недоступен. */
export function skippedResult(stage: string, title: string, message: string): ImportResult {
  return { stage, title, status: 'skipped', dataDate: null, rowsTotal: 0, rowsMatched: 0, written: 0, quarantined: 0, elapsedSec: 0, details: {}, message };
}

export function failedResult(stage: string, title: string, err: unknown, elapsedSec: number): ImportResult {
  return { ...skippedResult(stage, title, (err as Error)?.message ?? String(err)), status: 'failed', elapsedSec };
}
