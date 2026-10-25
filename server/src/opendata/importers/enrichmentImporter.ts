import type { PoolClient } from 'pg';
import type { Db } from '../../infra/db';
import type { Logger } from '../../logger';
import type { OpenDataset } from '../datasets/openDatasets';
import { freshness, type FactValue, type SupplierFact } from '../domain/fact';
import { type ImportResult, skippedResult } from '../domain/importResult';
import type { DatasetCache, LatestFile } from '../io/datasetCache';
import { forEachZipEntry, streamElements } from '../io/xmlStream';
import type { FnsDocumentParser } from '../parsing/fnsParsers';
import { type EntityScope, FactBatchWriter } from '../persistence/factBatchWriter';
import { ImportLog, OfficialSupplierIndex } from '../persistence/importLog';
import type { TransactionRunner } from '../persistence/transactionRunner';
import { Quarantine, QuarantineStore } from '../validation/quarantine';
import { type DatasetImporter, secondsSince } from './datasetImporter';

/**
 * Индекс официальных поставщиков, общий для всех наборов обогащения одного запуска.
 * Загружается при первом обращении — то есть после импорта реестра МСП, если он был в этом запуске.
 */
export class SupplierIndexProvider {
  private index: Promise<OfficialSupplierIndex> | null = null;

  constructor(private readonly db: Db) {}

  get(): Promise<OfficialSupplierIndex> {
    this.index ??= OfficialSupplierIndex.load(this.db);
    return this.index;
  }
}

export interface EnrichmentDeps {
  cache: DatasetCache;
  runner: TransactionRunner;
  suppliers: SupplierIndexProvider;
  log: Logger;
}

/**
 * Шаблон импорта набора «Прозрачного бизнеса» ФНС: потоковый проход по документам, сопоставление с базой по ИНН,
 * накопление сведений по поставщику и замена сведений набора одной транзакцией.
 * Подклассы задают разбор (parser), накопление (accumulate) и запись (persist).
 */
export abstract class AbstractEnrichmentImporter<TItem, TAcc> implements DatasetImporter {
  readonly group = 'enrichment';

  protected constructor(
    protected readonly dataset: OpenDataset,
    protected readonly parser: FnsDocumentParser<TItem>,
    protected readonly d: EnrichmentDeps,
  ) {}

  get stage(): string {
    return this.dataset.id;
  }

  get title(): string {
    return this.dataset.title;
  }

  /** Объединяет сведения нескольких документов об одной компании. */
  protected abstract accumulate(prev: TAcc | undefined, item: TItem): TAcc;

  /** Заменяет сведения набора в БД. Возвращает число записанных строк. */
  protected abstract persist(client: PoolClient, values: ReadonlyMap<string, TAcc>, meta: LatestFile, index: OfficialSupplierIndex): Promise<number>;

  async run(): Promise<ImportResult> {
    const meta = this.d.cache.latest(this.dataset.id);
    if (!meta) return skippedResult(this.stage, this.title, `набор не скачан: opendata download ${this.dataset.id}`);
    const index = await this.d.suppliers.get();
    if (!index.size) return skippedResult(this.stage, this.title, 'в базе нет официальных поставщиков: сначала импортируйте реестр МСП');

    const started = Date.now();
    const values = new Map<string, TAcc>();
    const quarantine = new Quarantine(this.dataset.id);
    let total = 0;
    let matched = 0;
    await forEachZipEntry(meta.file, async (_name, stream) => {
      await streamElements(stream, 'Документ', (doc) => {
        total += 1;
        const inn = this.parser.innOf(doc);
        const supplierId = index.idOf(inn);
        if (!supplierId) return;
        matched += 1;
        let item: TItem | null;
        try {
          item = this.parser.parse(doc);
        } catch (err) {
          quarantine.add(`ошибка разбора: ${(err as Error).message}`, inn ?? null, doc);
          return;
        }
        if (item !== null) values.set(supplierId, this.accumulate(values.get(supplierId), item));
      });
    });

    const written = await this.d.runner.run(`${this.stage} write`, async (client) => {
      const n = await this.persist(client, values, meta, index);
      await new QuarantineStore().replace(client, quarantine);
      await new ImportLog(client).record({
        dataset: this.dataset.id, source: this.dataset.source, title: this.title, dataDate: meta.dataDate, fileUrl: meta.url,
        rowsTotal: total, rowsMatched: matched, details: { suppliers: values.size, written: n },
      });
      return n;
    });
    this.d.log.info({ dataset: this.stage, total, matched, suppliers: values.size, written, sec: secondsSince(started) }, 'enrichment dataset imported');
    return {
      stage: this.stage, title: this.title, status: 'ok', dataDate: meta.dataDate, rowsTotal: total, rowsMatched: matched,
      written, quarantined: quarantine.count, elapsedSec: secondsSince(started),
      details: { suppliers: values.size, ...(quarantine.count ? { quarantineReasons: quarantine.reasons() } : {}) },
    };
  }
}

/**
 * Набор, который даёт одно сведение в карточке (verification_records): численность, спецрежим, задолженность…
 * Сведения набора заменяются целиком для той части базы, которую набор описывает (scope).
 */
export abstract class FactEnrichmentImporter<TItem, TAcc> extends AbstractEnrichmentImporter<TItem, TAcc> {
  protected abstract readonly field: string;
  /** Юрлица, ИП или все: у кого из поставщиков набор заменяет сведения. */
  protected readonly scope: EntityScope = 'ALL';
  private readonly writer = new FactBatchWriter();

  protected abstract toFact(acc: TAcc): FactValue;

  /** Сведение для поставщика из scope, которого нет в наборе (например, «задолженность не выявлена»). */
  protected fallback(): FactValue | null {
    return null;
  }

  protected persist(client: PoolClient, values: ReadonlyMap<string, TAcc>, meta: LatestFile, index: OfficialSupplierIndex): Promise<number> {
    const { checkedAt, freshUntil } = freshness(meta.dataDate, this.dataset.freshDays);
    const facts: SupplierFact[] = [];
    for (const [, supplierId] of index.entries(this.scope)) {
      const acc = values.get(supplierId);
      const fact = acc !== undefined ? this.toFact(acc) : this.fallback();
      if (!fact) continue;
      facts.push({ ...fact, supplierId, field: this.field, source: this.dataset.source, sourceUrl: this.dataset.passport, checkedAt, freshUntil, confidence: 0.95 });
    }
    return this.writer.replaceField(client, { field: this.field, source: this.dataset.source, scope: this.scope }, facts);
  }
}
