import type { OpendataContext } from '../context';
import { ImportCoordinator } from '../importCoordinator';
import { ImporterFactory, type Stage } from '../importers/importerFactory';
import { ImportRun } from '../importRun';
import { type CliCommand, splitArgs } from './command';
import { DownloadCommand } from './downloadCommand';

/**
 * Общий ход команд импорта: выбор этапов → координатор → отчёт о запуске в OPENDATA_REPORTS_DIR.
 * Подклассы задают только набор этапов и подготовку (например, скачивание).
 */
abstract class BaseImportCommand implements CliCommand {
  abstract readonly name: string;
  abstract readonly usage: string;

  constructor(protected readonly ctx: OpendataContext) {}

  protected abstract stages(positional: string[]): string[];

  protected async prepare(): Promise<void> {}

  async run(args: string[]): Promise<number> {
    const { positional, flags } = splitArgs(args);
    const stages = ImporterFactory.resolve(this.stages(positional));
    await this.prepare();
    const factory = new ImporterFactory(this.ctx, await this.ctx.db(), { offline: flags.has('offline') });
    const run = new ImportRun(['opendata', this.name, ...args].join(' '));
    await new ImportCoordinator(stages.map((s: Stage) => factory.create(s)), factory.postSteps(), this.ctx.log).run(run);

    const report = run.report();
    const saved = this.ctx.reports.save('import-run', report);
    console.log(report.markdown);
    this.ctx.log.info({ ...saved, failed: run.failed, sec: run.elapsedSec }, 'import run finished');
    return run.failed ? 1 : 0;
  }
}

/** import [этапы|группы...] — без аргументов реестр МСП и все наборы обогащения ФНС. */
export class ImportCommand extends BaseImportCommand {
  readonly name = 'import';
  readonly usage = 'import [rsmp|enrich|<этап>...] — загрузить скачанные наборы в PostgreSQL (без аргументов — все наборы ФНС)';

  protected stages(positional: string[]) {
    return positional.length ? positional : ['fns'];
  }
}

/** enrich — только налоговые наборы и реестр поддержки, без повторного разбора реестра МСП. */
export class EnrichCommand extends BaseImportCommand {
  readonly name = 'enrich';
  readonly usage = 'enrich — наборы обогащения ФНС без повторного разбора реестра МСП';

  protected stages() {
    return ['enrich'];
  }
}

/** all — скачать свежие версии наборов ФНС и загрузить их. */
export class AllCommand extends BaseImportCommand {
  readonly name = 'all';
  readonly usage = 'all — download + import всех наборов ФНС';

  protected stages() {
    return ['fns'];
  }

  protected async prepare() {
    // Недоступный набор не мешает загрузить остальные: импорт возьмёт последнюю скачанную версию
    await new DownloadCommand(this.ctx).downloadAll([]);
  }
}

/** fsa [rds|rss] [--offline] — декларации и сертификаты Росаккредитации. */
export class FsaCommand extends BaseImportCommand {
  readonly name = 'fsa';
  readonly usage = 'fsa [rds|rss] [--offline] — декларации и сертификаты Росаккредитации (--offline: только скачанные архивы)';

  protected stages(positional: string[]) {
    const bad = positional.filter((k) => k !== 'rds' && k !== 'rss');
    if (bad.length) throw new Error(`Вид набора Росаккредитации: rds или rss, а не ${bad.join(', ')}`);
    return positional.length ? positional.map((k) => `fsa-${k}`) : ['fsa'];
  }
}

/** rnp [--offline] — реестр недобросовестных поставщиков ФАС. */
export class RnpCommand extends BaseImportCommand {
  readonly name = 'rnp';
  readonly usage = 'rnp [--offline] — РНП ФАС (--offline: CSV уже лежит в <OPENDATA_DIR>/rnp)';

  protected stages() {
    return ['rnp'];
  }
}
