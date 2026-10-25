import { analysisReport, RsmpAnalyzer } from '../analysis/rsmpAnalyzer';
import type { OpendataContext } from '../context';
import type { CliCommand } from './command';

/** Эталон из README: компаний на данных 10.09.2026 при 17 категориях. */
export const README_BENCHMARK = 201_962;

/** analyze [rsmp] — диагностика реестра МСП без записи в БД: сколько компаний и категорий даст импорт. */
export class AnalyzeCommand implements CliCommand {
  readonly name = 'analyze';
  readonly usage = 'analyze [rsmp] — прогноз базы по реестру МСП без записи в БД';

  constructor(private readonly ctx: OpendataContext) {}

  async run(args: string[]): Promise<number> {
    const dataset = args[0] ?? 'rsmp';
    if (dataset !== 'rsmp') throw new Error(`Диагностика доступна только для реестра МСП, а не для «${dataset}»`);
    const latest = this.ctx.cache.latest('rsmp');
    if (!latest) throw new Error('Архив реестра МСП не скачан: запустите `opendata download rsmp`');

    const analysis = await new RsmpAnalyzer(this.ctx.catalog, this.ctx.log, this.ctx.regions).analyze(latest.file, latest.dataDate);
    const report = analysisReport(analysis, this.ctx.regions ? undefined : README_BENCHMARK);
    const saved = this.ctx.reports.save('rsmp-analysis', report);
    console.log(report.markdown);
    this.ctx.log.info({ ...saved, companies: analysis.uniqueCompanies }, 'rsmp analysis saved');
    return 0;
  }
}
