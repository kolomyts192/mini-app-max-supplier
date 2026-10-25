import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../logger';
import { FAS_RNP } from '../datasets/openDatasets';
import { type ImportResult, skippedResult } from '../domain/importResult';
import { streamCsv } from '../io/csvStream';
import type { DatasetCache } from '../io/datasetCache';
import type { DatasetDownloader } from '../io/downloader';
import { type RnpColumns, RnpParser } from '../parsing/rnpParser';
import { ImportLog } from '../persistence/importLog';
import { type RiskSignalRow, RiskSignalWriter } from '../persistence/sourceWriters';
import type { TransactionRunner } from '../persistence/transactionRunner';
import { type DatasetImporter, secondsSince } from './datasetImporter';
import type { SupplierIndexProvider } from './enrichmentImporter';

export interface RnpImporterDeps {
  cache: DatasetCache;
  runner: TransactionRunner;
  suppliers: SupplierIndexProvider;
  log: Logger;
  /** null — офлайн: CSV уже лежит в <OPENDATA_DIR>/rnp (с зарубежных IP fas.gov.ru недоступен). */
  downloader: DatasetDownloader | null;
  now?: () => Date;
}

/**
 * РНП ФАС → risk_signals. Запись в реестре действует два года с даты включения, поэтому истёкшие записи
 * и записи без даты риск-сигналом не становятся: устаревший сигнал вводил бы в заблуждение.
 */
export class RnpImporter implements DatasetImporter {
  readonly stage = FAS_RNP.id;
  readonly title = FAS_RNP.title;
  readonly group = 'risks';
  private readonly parser = new RnpParser();
  private readonly writer = new RiskSignalWriter();

  constructor(private readonly d: RnpImporterDeps) {}

  async run(): Promise<ImportResult> {
    const file = await this.locate();
    if (!file) return skippedResult(this.stage, this.title, `нет CSV РНП в ${this.d.cache.folder(this.stage)}: положите выгрузку с fas.gov.ru или запустите без --offline с российского IP`);
    const index = await this.d.suppliers.get();
    if (!index.size) return skippedResult(this.stage, this.title, 'в базе нет официальных поставщиков: сначала импортируйте реестр МСП');

    const started = Date.now();
    const activeSince = new Date(this.d.now?.() ?? new Date());
    activeSince.setUTCDate(activeSince.getUTCDate() - FAS_RNP.freshDays);
    const since = activeSince.toISOString().slice(0, 10);
    let cols: RnpColumns | null = null;
    const counts = { total: 0, matched: 0, expired: 0, undated: 0 };
    const rows: RiskSignalRow[] = [];
    await streamCsv(fs.createReadStream(file.path), (h) => (cols = this.parser.columns(h)), (cells) => {
      if (!cols) return;
      counts.total += 1;
      const r = this.parser.row(cells, cols);
      const supplierId = index.idOf(r?.inn);
      if (!r || !supplierId) return;
      counts.matched += 1;
      if (!r.includedAt) return void (counts.undated += 1);
      if (r.includedAt < since) return void (counts.expired += 1);
      rows.push({ supplierId, kind: 'RNP', title: 'Запись в реестре недобросовестных поставщиков', details: r.reason, recordNumber: r.number, publishedAt: r.includedAt, sourceUrl: FAS_RNP.passport, checkedAt: `${file.dataDate}T00:00:00Z` });
    });

    await this.d.runner.run('rnp write', async (client) => {
      await this.writer.replaceSource(client, FAS_RNP.source, rows);
      await new ImportLog(client).record({
        dataset: this.stage, source: FAS_RNP.source, title: this.title, dataDate: file.dataDate, fileUrl: file.url,
        rowsTotal: counts.total, rowsMatched: rows.length, details: { ...counts, activeSince: since },
      });
    });
    return {
      stage: this.stage, title: this.title, status: 'ok', dataDate: file.dataDate, rowsTotal: counts.total, rowsMatched: counts.matched,
      written: rows.length, quarantined: 0, elapsedSec: secondsSince(started), details: { ...counts, activeSince: since },
    };
  }

  /** Свежая версия с fas.gov.ru или самый новый CSV из папки набора. */
  private async locate(): Promise<{ path: string; dataDate: string; url: string } | null> {
    if (this.d.downloader) {
      const latest = await this.d.downloader.latestVersion(FAS_RNP.passport);
      const dest = this.d.cache.pathFor(this.stage, latest.url);
      await this.d.downloader.download(latest.url, dest);
      this.d.cache.saveLatest(this.stage, { file: dest, dataDate: latest.dataDate, url: latest.url });
      return { path: dest, dataDate: latest.dataDate, url: latest.url };
    }
    const folder = this.d.cache.folder(this.stage);
    const csv = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => /\.csv$/i.test(f)).sort().at(-1) : undefined;
    if (!csv) return null;
    const file = path.join(folder, csv);
    const d = /data-(\d{8})/.exec(csv)?.[1];
    const dataDate = d ? (/^20/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`) : fs.statSync(file).mtime.toISOString().slice(0, 10);
    return { path: file, dataDate, url: `${FAS_RNP.passport}${csv}` };
  }
}
