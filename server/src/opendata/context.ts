import fs from 'node:fs';
import path from 'node:path';
import { Catalog } from '../catalog/catalog';
import type { Config } from '../config';
import { createDb, type Db, runMigrations } from '../infra/db';
import type { Logger } from '../logger';
import { DatasetCache } from './io/datasetCache';
import { ReportStore } from './io/reportStore';

/**
 * Общие зависимости команд открытых данных. Справочник и подключение к БД создаются по требованию:
 * скачивание и диагностика работают без PostgreSQL.
 */
export class OpendataContext {
  readonly cache: DatasetCache;
  readonly reports: ReportStore;
  private catalogInstance: Catalog | null = null;
  private dbInstance: Promise<Db> | null = null;

  constructor(
    readonly config: Config,
    readonly log: Logger,
  ) {
    const dir = path.resolve(config.OPENDATA_DIR);
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new DatasetCache(dir);
    this.reports = new ReportStore(path.resolve(config.OPENDATA_REPORTS_DIR ?? path.join(dir, 'reports')));
  }

  get catalog(): Catalog {
    this.catalogInstance ??= Catalog.load(this.config.dataDir);
    return this.catalogInstance;
  }

  /** Регионы импорта из OPENDATA_REGIONS: null — вся Россия. */
  get regions(): ReadonlySet<string> | null {
    const codes = this.config.OPENDATA_REGIONS.split(',').map((s) => s.trim()).filter(Boolean);
    return codes.length ? new Set(codes) : null;
  }

  /** Подключение к БД с применёнными миграциями. */
  db(): Promise<Db> {
    this.dbInstance ??= (async () => {
      const db = createDb(this.config.DATABASE_URL);
      await runMigrations(db, this.config.migrationsDir, this.log);
      return db;
    })();
    return this.dbInstance;
  }

  async close(): Promise<void> {
    if (!this.dbInstance) return;
    const db = await this.dbInstance.catch(() => null);
    await db?.end();
  }
}
