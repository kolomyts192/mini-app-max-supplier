import path from 'node:path';
import type { Catalog } from '../../catalog/catalog';
import type { Logger } from '../../logger';
import { FNS } from '../datasets/openDatasets';
import type { Company } from '../domain/company';
import type { ImportResult } from '../domain/importResult';
import type { DatasetCache, LatestFile } from '../io/datasetCache';
import { forEachZipEntry, streamElements } from '../io/xmlStream';
import { RsmpParser } from '../parsing/rsmpParser';
import { FactBatchWriter } from '../persistence/factBatchWriter';
import { ImportLog } from '../persistence/importLog';
import { ProductBatchWriter } from '../persistence/productBatchWriter';
import { SupplierBatchWriter } from '../persistence/supplierBatchWriter';
import type { TransactionRunner } from '../persistence/transactionRunner';
import { CompanyValidator } from '../validation/companyValidator';
import { Quarantine, QuarantineStore } from '../validation/quarantine';
import { bindToSuppliers, type DatasetImporter, secondsSince } from './datasetImporter';
import { RsmpRowMapper } from './rsmpRowMapper';

export interface RsmpImporterDeps {
  cache: DatasetCache;
  catalog: Catalog;
  runner: TransactionRunner;
  log: Logger;
  regions: ReadonlySet<string> | null;
  batchSize?: number;
}

interface RsmpStats {
  files: number;
  total: number;
  matched: number;
  writes: number;
  duplicateInn: number;
  ogrnConflicts: number;
  companies: Set<string>;
  byCategory: Record<string, number>;
}

/**
 * Единый реестр МСП → реальные поставщики товарной вертикали. Разбор потоковый, запись — батчами
 * в одной транзакции на батч; невалидные записи уходят в карантин, импорт продолжается.
 * Повторный запуск на той же версии реестра не создаёт дублей: upsert по ИНН и замена сведений поставщика.
 */
export class RsmpImporter implements DatasetImporter {
  readonly stage = FNS.rsmp.id;
  readonly title = FNS.rsmp.title;
  readonly group = 'registry';

  private readonly parser: RsmpParser;
  private readonly validator = new CompanyValidator();
  private readonly mapper: RsmpRowMapper;
  private readonly suppliers = new SupplierBatchWriter();
  private readonly products = new ProductBatchWriter();
  private readonly facts = new FactBatchWriter();
  private readonly quarantineStore = new QuarantineStore();
  private readonly batchSize: number;

  constructor(private readonly d: RsmpImporterDeps) {
    this.parser = new RsmpParser(d.catalog, d.regions);
    this.mapper = new RsmpRowMapper(d.catalog, { id: FNS.rsmp.source, url: FNS.rsmp.passport, freshDays: FNS.rsmp.freshDays });
    this.batchSize = d.batchSize ?? 1000;
  }

  async run(): Promise<ImportResult> {
    const meta = this.d.cache.latest(this.stage);
    if (!meta) throw new Error('Архив реестра МСП не скачан: запустите `opendata download rsmp`');
    const started = Date.now();
    const stats: RsmpStats = { files: 0, total: 0, matched: 0, writes: 0, duplicateInn: 0, ogrnConflicts: 0, companies: new Set(), byCategory: {} };
    const quarantine = new Quarantine(this.stage);
    this.d.log.info({ file: path.basename(meta.file), dataDate: meta.dataDate, regions: this.d.regions ? [...this.d.regions] : 'all' }, 'rsmp import started');

    let batch: Company[] = [];
    await forEachZipEntry(meta.file, async (_name, stream) => {
      stats.files += 1;
      await streamElements(stream, 'Документ', async (doc) => {
        stats.total += 1;
        const company = this.accept(doc, quarantine);
        if (!company) return;
        stats.matched += 1;
        for (const id of company.categories) stats.byCategory[id] = (stats.byCategory[id] ?? 0) + 1;
        batch.push(company);
        if (batch.length >= this.batchSize) {
          const full = batch;
          batch = [];
          await this.flush(full, meta, stats);
        }
      });
      if (stats.files % 500 === 0) {
        const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
        this.d.log.info({ files: stats.files, documents: stats.total, companies: stats.companies.size, quarantined: quarantine.count, heapMb, sec: secondsSince(started) }, 'rsmp import progress');
      }
    });
    await this.flush(batch, meta, stats);

    const excluded = await this.d.runner.run('rsmp finalize', async (client) => {
      const n = await this.suppliers.markNotSeen(client, meta.dataDate, this.d.regions);
      await this.quarantineStore.replace(client, quarantine);
      await new ImportLog(client).record({
        dataset: this.stage, source: FNS.rsmp.source, title: this.title, dataDate: meta.dataDate, fileUrl: meta.url,
        rowsTotal: stats.total, rowsMatched: stats.companies.size,
        details: { files: stats.files, byCategory: stats.byCategory, excluded: n, quarantined: quarantine.count, regions: this.d.regions ? [...this.d.regions] : null },
      });
      return n;
    });

    return {
      stage: this.stage,
      title: this.title,
      status: 'ok',
      dataDate: meta.dataDate,
      rowsTotal: stats.total,
      rowsMatched: stats.matched,
      written: stats.companies.size,
      quarantined: quarantine.count,
      elapsedSec: secondsSince(started),
      details: {
        files: stats.files,
        byCategory: stats.byCategory,
        duplicateInnDocuments: stats.duplicateInn + (stats.writes - stats.companies.size),
        ogrnConflicts: stats.ogrnConflicts,
        excludedFromRegistry: excluded,
        quarantineReasons: quarantine.reasons(),
      },
    };
  }

  /** Компания вертикали с корректными реквизитами; иначе null (вне вертикали или в карантине). */
  private accept(doc: string, quarantine: Quarantine): Company | null {
    let company: Company | null;
    try {
      company = this.parser.parse(doc).company;
    } catch (err) {
      quarantine.add(`ошибка разбора: ${(err as Error).message}`, /ИНН(?:ЮЛ|ФЛ)="(\d+)"/.exec(doc)?.[1] ?? null, doc);
      return null;
    }
    if (!company) return null;
    const issues = this.validator.validate(company);
    if (!issues.length) return company;
    quarantine.add(issues.map((i) => i.reason).join('; '), company.inn, doc);
    return null;
  }

  private async flush(batch: Company[], meta: LatestFile, stats: RsmpStats): Promise<void> {
    if (!batch.length) return;
    // Одна запись на ИНН в батче: повтор документа заменяет предыдущий
    const unique = [...new Map(batch.map((c) => [c.inn, c])).values()];
    stats.duplicateInn += batch.length - unique.length;
    const rows = this.mapper.map(unique, meta.dataDate);
    const prepared = SupplierBatchWriter.prepare(rows.suppliers);
    stats.ogrnConflicts += prepared.ogrnConflicts;

    const written = await this.d.runner.run('rsmp batch', async (client) => {
      const ids = await this.suppliers.upsert(client, prepared.rows);
      const supplierIds = [...ids.values()];
      await this.products.replace(client, supplierIds, bindToSuppliers(rows.products, ids));
      await this.facts.replaceForSuppliers(client, FNS.rsmp.source, supplierIds, bindToSuppliers(rows.facts, ids));
      return [...ids.keys()];
    });
    stats.writes += written.length;
    for (const inn of written) stats.companies.add(inn);
  }
}
