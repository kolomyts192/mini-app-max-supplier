import type { PoolClient } from 'pg';
import type { Db } from '../../infra/db';
import type { Logger } from '../../logger';
import { retry, type RetryOptions } from '../../sources/resilience';

/** Коды PostgreSQL, после которых транзакцию можно безопасно повторить: конфликт, перезапуск, обрыв, нехватка соединений. */
const TRANSIENT_PG = new Set(['40001', '40P01', '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006']);
const TRANSIENT_NET = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/**
 * Транзакция на батч с повторами при временных ошибках БД. Ошибка данных (нарушение ограничения,
 * неверный тип) не повторяется: она воспроизведётся и должна остановить этап.
 */
export class TransactionRunner {
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    opts: Partial<Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>> = {},
  ) {
    this.retryOptions = { attempts: opts.attempts ?? 5, baseDelayMs: opts.baseDelayMs ?? 500, maxDelayMs: opts.maxDelayMs ?? 15_000, isRetryable: TransactionRunner.isTransient };
  }

  static isTransient(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    if (code && (TRANSIENT_PG.has(code) || TRANSIENT_NET.has(code))) return true;
    return /Connection terminated|connection timeout/i.test((err as Error)?.message ?? '');
  }

  run<T>(label: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return retry(async (attempt) => {
      try {
        return await this.once(fn);
      } catch (err) {
        if (TransactionRunner.isTransient(err) && attempt < this.retryOptions.attempts) {
          this.log.warn({ label, attempt, err: (err as Error).message }, 'transient database error, retrying batch');
        }
        throw err;
      }
    }, this.retryOptions);
  }

  private async once<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // ROLLBACK на оборванном соединении тоже упадёт: такое соединение не возвращаем в пул
      await client.query('ROLLBACK').catch((e: Error) => (broken = e));
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
