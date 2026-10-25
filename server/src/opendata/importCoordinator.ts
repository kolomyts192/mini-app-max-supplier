import type { Db } from '../infra/db';
import type { Logger } from '../logger';
import { refreshProfileFlags } from '../search/repository';
import { failedResult, skippedResult } from './domain/importResult';
import type { DatasetImporter } from './importers/datasetImporter';
import type { ImportRun } from './importRun';

/** Служебный шаг после импорта наборов. */
export interface PostImportStep {
  readonly name: string;
  run(): Promise<Record<string, unknown>>;
}

/** Признаки полноты профиля (численность, выручка), по которым сортируются кандидаты в поиске. */
export class ProfileFlagsStep implements PostImportStep {
  readonly name = 'Пересчёт has_employees / has_revenue';

  constructor(private readonly db: Db) {}

  async run() {
    return { updated: await refreshProfileFlags(this.db) };
  }
}

/** VACUUM ANALYZE таблиц, которые импорт перезаписывает массово: убирает «мёртвые» строки и обновляет статистику планировщика. */
export class DatabaseMaintenanceStep implements PostImportStep {
  readonly name = 'VACUUM ANALYZE';
  private static readonly TABLES = ['suppliers', 'product_records', 'verification_records', 'financial_reports', 'compliance_documents', 'risk_signals', 'opendata_quarantine'];

  constructor(private readonly db: Db) {}

  async run() {
    for (const table of DatabaseMaintenanceStep.TABLES) await this.db.query(`VACUUM (ANALYZE) ${table}`);
    return { tables: DatabaseMaintenanceStep.TABLES.length };
  }
}

/**
 * Порядок этапов импорта и обработка их итогов. Ошибка набора обогащения не останавливает остальные;
 * ошибка реестра МСП останавливает запуск — без него сведения привязывались бы к устаревшей базе.
 */
export class ImportCoordinator {
  constructor(
    private readonly importers: readonly DatasetImporter[],
    private readonly postSteps: readonly PostImportStep[],
    private readonly log: Logger,
  ) {}

  async run(run: ImportRun): Promise<ImportRun> {
    let stopped: string | null = null;
    for (const importer of this.importers) {
      if (stopped) {
        run.addStage(skippedResult(importer.stage, importer.title, `не выполнялся: ${stopped}`));
        continue;
      }
      const started = Date.now();
      this.log.info({ stage: importer.stage }, 'import stage started');
      try {
        const result = await importer.run();
        run.addStage(result);
        this.log.info({ stage: importer.stage, status: result.status, written: result.written, sec: result.elapsedSec, message: result.message }, 'import stage finished');
      } catch (err) {
        run.addStage(failedResult(importer.stage, importer.title, err, Math.round((Date.now() - started) / 1000)));
        this.log.error({ stage: importer.stage, err: (err as Error).message }, 'import stage failed');
        if (importer.group === 'registry') stopped = `ошибка этапа ${importer.stage}`;
      }
    }

    if (run.succeeded) {
      for (const step of this.postSteps) {
        const started = Date.now();
        const details = await step.run();
        run.addStep({ name: step.name, elapsedSec: Math.round((Date.now() - started) / 1000), details });
      }
    }
    run.finish();
    return run;
  }
}
