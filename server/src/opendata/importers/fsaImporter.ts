import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Catalog } from '../../catalog/catalog';
import type { Logger } from '../../logger';
import { matchProduct } from '../../parser/queryParser';
import { FsaArchiveSet, type FsaDataset, type FsaSource } from '../datasets/fsaDatasets';
import { type ImportResult, skippedResult } from '../domain/importResult';
import { streamCsv } from '../io/csvStream';
import type { DatasetDownloader } from '../io/downloader';
import type { SevenZip } from '../io/sevenZip';
import { forEachZipEntry } from '../io/xmlStream';
import { CatalogClassifier } from '../parsing/classify';
import { type FsaColumns, type FsaDocument, FsaParser } from '../parsing/fsaParser';
import { ImportLog } from '../persistence/importLog';
import { type ComplianceDocumentRow, ComplianceDocumentWriter } from '../persistence/sourceWriters';
import type { TransactionRunner } from '../persistence/transactionRunner';
import { type DatasetImporter, secondsSince } from './datasetImporter';
import type { SupplierIndexProvider } from './enrichmentImporter';

/** Документов одного вида на компанию после объединения срезов: действующие и самые свежие. */
const DOCS_PER_SUPPLIER = 30;

/** Документы поставщиков с ограничением числа на компанию: лишние отбрасываются по ходу чтения, чтобы не держать миллионы строк. */
class SupplierDocuments {
  private readonly bySupplier = new Map<string, Map<string, FsaDocument>>();

  constructor(private readonly limit: number) {}

  add(supplierId: string, doc: FsaDocument): void {
    const docs = this.bySupplier.get(supplierId) ?? new Map<string, FsaDocument>();
    // Более поздний срез заменяет запись о том же документе
    docs.set(doc.number, doc);
    if (docs.size > this.limit * 4) this.prune(docs, this.limit * 2);
    this.bySupplier.set(supplierId, docs);
  }

  get suppliers(): number {
    return this.bySupplier.size;
  }

  *top(): Iterable<[string, FsaDocument]> {
    for (const [supplierId, docs] of this.bySupplier) {
      for (const d of this.sorted(docs).slice(0, this.limit)) yield [supplierId, d];
    }
  }

  private prune(docs: Map<string, FsaDocument>, keep: number): void {
    const kept = this.sorted(docs).slice(0, keep);
    docs.clear();
    for (const d of kept) docs.set(d.number, d);
  }

  private sorted(docs: Map<string, FsaDocument>): FsaDocument[] {
    return [...docs.values()].sort((a, b) => FsaParser.rank(b).localeCompare(FsaParser.rank(a)));
  }
}

export interface FsaImporterDeps {
  dir: string;
  catalog: Catalog;
  runner: TransactionRunner;
  suppliers: SupplierIndexProvider;
  sevenZip: () => SevenZip;
  log: Logger;
  /** null — офлайн: архивы уже лежат в папке (с зарубежных IP fsa.gov.ru недоступен). */
  downloader: DatasetDownloader | null;
}

/**
 * Открытые данные Росаккредитации → compliance_documents. Объединяет все срезы из папки набора: более поздняя
 * запись о документе заменяет раннюю. Документ привязывается к поставщику по ИНН изготовителя или заявителя,
 * к товару — по кодам ОКПД2 и справочнику синонимов. Файл с нераспознанной структурой пропускается с предупреждением.
 */
export class FsaImporter implements DatasetImporter {
  readonly group = 'documents';
  private readonly parser = new FsaParser();
  private readonly writer = new ComplianceDocumentWriter();
  private readonly classifier: CatalogClassifier;

  constructor(
    private readonly dataset: FsaDataset,
    private readonly d: FsaImporterDeps,
  ) {
    this.classifier = CatalogClassifier.for(d.catalog);
  }

  get stage(): string {
    return this.dataset.stage;
  }

  get title(): string {
    return this.dataset.title;
  }

  async run(): Promise<ImportResult> {
    const folder = this.dataset.folder(this.d.dir);
    const downloadError = await this.downloadLatest(folder);
    const { sources, archives, dataDate } = await new FsaArchiveSet(folder, this.d.sevenZip).discover();
    if (!sources.length || !dataDate) return skippedResult(this.stage, this.title, `нет архивов Росаккредитации в ${folder}${downloadError ? `; скачать не удалось: ${downloadError}` : ''}`);
    const index = await this.d.suppliers.get();
    if (!index.size) return skippedResult(this.stage, this.title, 'в базе нет официальных поставщиков: сначала импортируйте реестр МСП');

    const started = Date.now();
    this.d.log.info({ dataset: this.stage, archives: archives.length, files: sources.length, from: sources[0].period, to: sources.at(-1)!.period }, 'fsa import started');
    const docs = new SupplierDocuments(DOCS_PER_SUPPLIER);
    const skipped: string[] = [];
    let total = 0;
    let matched = 0;
    for (const src of sources) {
      const before = total;
      let cols: FsaColumns | null = null;
      const file = src.entry ?? path.basename(src.archive);
      await this.read(src, (header) => {
        try {
          cols = this.parser.columns(header);
        } catch (err) {
          skipped.push(file);
          this.d.log.warn({ dataset: this.stage, file, err: (err as Error).message.slice(0, 400) }, 'fsa file skipped');
        }
      }, (cells) => {
        if (!cols) return;
        total += 1;
        const doc = this.parser.row(cells, cols);
        if (!doc) return;
        let hit = false;
        for (const inn of new Set([doc.manufacturerInn, doc.applicantInn])) {
          const supplierId = index.idOf(inn ?? undefined);
          if (!supplierId) continue;
          docs.add(supplierId, doc);
          hit = true;
        }
        if (hit) matched += 1;
      });
      this.d.log.info({ dataset: this.stage, file, rows: total - before, suppliers: docs.suppliers, sec: secondsSince(started) }, 'fsa file imported');
    }

    const rows = [...docs.top()].map(([supplierId, doc]) => this.toRow(supplierId, doc, dataDate));
    const newest = archives.at(-1)!;
    await this.d.runner.run(`${this.stage} write`, async (client) => {
      await this.writer.replaceSource(client, this.dataset.source, rows);
      await new ImportLog(client).record({
        dataset: this.stage, source: this.dataset.source, title: this.title, dataDate, fileUrl: `${this.dataset.passport}${newest}`,
        rowsTotal: total, rowsMatched: rows.length,
        details: { suppliers: docs.suppliers, files: sources.length, skipped, periodFrom: sources[0].period, periodTo: sources.at(-1)!.period },
      });
    });
    return {
      stage: this.stage, title: this.title, status: 'ok', dataDate, rowsTotal: total, rowsMatched: matched, written: rows.length, quarantined: 0,
      elapsedSec: secondsSince(started),
      details: {
        suppliers: docs.suppliers, archives: archives.length, files: sources.length, skippedFiles: skipped,
        withProduct: rows.filter((r) => r.productId).length, periodFrom: sources[0].period, periodTo: sources.at(-1)!.period,
        ...(downloadError ? { downloadError } : {}),
      },
    };
  }

  /** Свежий архив с fsa.gov.ru; при недоступности сайта импорт продолжается по уже скачанным архивам. */
  private async downloadLatest(folder: string): Promise<string | null> {
    if (!this.d.downloader) return null;
    try {
      const latest = await this.d.downloader.latestVersion(this.dataset.passport);
      fs.mkdirSync(folder, { recursive: true });
      await this.d.downloader.download(latest.url, path.join(folder, path.basename(new URL(latest.url).pathname)));
      return null;
    } catch (err) {
      this.d.log.warn({ dataset: this.stage, err: (err as Error).message }, 'fsa download failed, using cached archives');
      return (err as Error).message;
    }
  }

  private read(src: FsaSource, onHeader: (h: string[]) => void, onRow: (cells: string[]) => void): Promise<void> {
    const parse = (s: Readable) => streamCsv(s, onHeader, onRow).then(() => undefined);
    if (src.entry && /\.7z$/i.test(src.archive)) return this.d.sevenZip().streamEntry(src.archive, src.entry, parse);
    if (src.entry) return forEachZipEntry(src.archive, (e, s) => (e === src.entry ? parse(s) : Promise.resolve(void s.resume())), /\.csv$/i).then(() => undefined);
    return parse(fs.createReadStream(src.archive));
  }

  private toRow(supplierId: string, d: FsaDocument, dataDate: string): ComplianceDocumentRow {
    const byCode = d.okpd2.flatMap((c) => this.classifier.productsForOkpd2(c))[0];
    const byName = !byCode && d.product ? matchProduct(d.product, this.d.catalog)[0] : undefined;
    return {
      supplierId,
      productId: byCode?.productId ?? (byName && byName.confidence >= 0.6 ? byName.productId : null),
      type: this.dataset.type,
      number: d.number,
      status: d.status,
      manufacturerInn: d.manufacturerInn,
      manufacturerName: d.manufacturerName,
      applicant: d.applicantName,
      productName: d.product,
      techRegulation: d.techRegulation,
      body: d.body,
      validFrom: d.validFrom,
      validTo: d.validTo,
      sourceUrl: this.dataset.passport,
      checkedAt: `${dataDate}T00:00:00Z`,
    };
  }
}
