import type { Db } from '../../infra/db';
import type { OpendataContext } from '../context';
import { FSA } from '../datasets/fsaDatasets';
import { DatabaseMaintenanceStep, type PostImportStep, ProfileFlagsStep } from '../importCoordinator';
import { DatasetDownloader } from '../io/downloader';
import { SevenZip } from '../io/sevenZip';
import { TransactionRunner } from '../persistence/transactionRunner';
import type { DatasetImporter } from './datasetImporter';
import { type EnrichmentDeps, SupplierIndexProvider } from './enrichmentImporter';
import {
  DebtImporter,
  EmployeesImporter,
  IpTaxRegimeImporter,
  PaytaxImporter,
  RevenueImporter,
  SupportImporter,
  TaxOffenceImporter,
  TaxRegimeImporter,
} from './fnsEnrichment';
import { FsaImporter } from './fsaImporter';
import { RnpImporter } from './rnpImporter';
import { RsmpImporter } from './rsmpImporter';

/** Этапы в порядке выполнения: реестр МСП, обогащение (численность → … → доходы/расходы), РНП, Росаккредитация. */
export const STAGES = ['rsmp', 'sshr', 'snr', 'snrip', 'debtam', 'paytax', 'taxoffence', 'rsmppp', 'revexp', 'rnp', 'fsa-rss', 'fsa-rds'] as const;
export type Stage = (typeof STAGES)[number];

const ENRICH: Stage[] = ['sshr', 'snr', 'snrip', 'debtam', 'paytax', 'taxoffence', 'rsmppp', 'revexp'];

/** Группы этапов для командной строки. */
export const STAGE_GROUPS: Record<string, Stage[]> = {
  fns: ['rsmp', ...ENRICH],
  enrich: ENRICH,
  fsa: ['fsa-rss', 'fsa-rds'],
};

export interface FactoryOptions {
  /** Не обращаться к сайтам источников: архивы уже скачаны (FSA, РНП). */
  offline: boolean;
}

/** Сборка импортёров с зависимостями. Общие на запуск: транзакции с повторами и индекс поставщиков. */
export class ImporterFactory {
  private readonly runner: TransactionRunner;
  private readonly suppliers: SupplierIndexProvider;
  private sevenZipInstance: SevenZip | null = null;

  constructor(
    private readonly ctx: OpendataContext,
    private readonly db: Db,
    private readonly opts: FactoryOptions,
  ) {
    this.runner = new TransactionRunner(db, ctx.log);
    this.suppliers = new SupplierIndexProvider(db);
  }

  /** Раскрывает группы и упорядочивает этапы; неизвестное имя — ошибка с перечнем допустимых. */
  static resolve(selection: string[]): Stage[] {
    const wanted = new Set<string>();
    for (const s of selection) {
      const group = STAGE_GROUPS[s];
      if (group) group.forEach((g) => wanted.add(g));
      else if ((STAGES as readonly string[]).includes(s)) wanted.add(s);
      else throw new Error(`Неизвестный этап «${s}». Этапы: ${STAGES.join(', ')}; группы: ${Object.keys(STAGE_GROUPS).join(', ')}`);
    }
    return STAGES.filter((s) => wanted.has(s));
  }

  create(stage: Stage): DatasetImporter {
    const enrichment: EnrichmentDeps = { cache: this.ctx.cache, runner: this.runner, suppliers: this.suppliers, log: this.ctx.log };
    const downloader = this.opts.offline ? null : new DatasetDownloader(this.ctx.log);
    switch (stage) {
      case 'rsmp':
        return new RsmpImporter({ cache: this.ctx.cache, catalog: this.ctx.catalog, runner: this.runner, log: this.ctx.log, regions: this.ctx.regions });
      case 'sshr':
        return new EmployeesImporter(enrichment);
      case 'snr':
        return new TaxRegimeImporter(enrichment);
      case 'snrip':
        return new IpTaxRegimeImporter(enrichment);
      case 'debtam':
        return new DebtImporter(enrichment);
      case 'paytax':
        return new PaytaxImporter(enrichment);
      case 'taxoffence':
        return new TaxOffenceImporter(enrichment);
      case 'rsmppp':
        return new SupportImporter(enrichment);
      case 'revexp':
        return new RevenueImporter(enrichment);
      case 'rnp':
        return new RnpImporter({ ...enrichment, downloader });
      case 'fsa-rss':
      case 'fsa-rds':
        return new FsaImporter(FSA[stage === 'fsa-rss' ? 'rss' : 'rds'], {
          dir: this.ctx.cache.dir, catalog: this.ctx.catalog, runner: this.runner, suppliers: this.suppliers, log: this.ctx.log, downloader,
          sevenZip: () => (this.sevenZipInstance ??= SevenZip.detect()),
        });
    }
  }

  postSteps(): PostImportStep[] {
    return [new ProfileFlagsStep(this.db), new DatabaseMaintenanceStep(this.db)];
  }
}
