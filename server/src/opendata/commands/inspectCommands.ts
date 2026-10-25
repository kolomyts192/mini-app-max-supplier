import { CoverageAnalyzer, coverageReport } from '../analysis/coverageAnalyzer';
import { ImportVerifier, verificationReport } from '../analysis/importVerifier';
import type { OpendataContext } from '../context';
import type { CliCommand } from './command';

/** verify — проверка базы по критериям приёмки; код 1, если не пройден хотя бы один. */
export class VerifyCommand implements CliCommand {
  readonly name = 'verify';
  readonly usage = 'verify — дубли, пустые реквизиты, категории, наборы и идемпотентность базы';

  constructor(private readonly ctx: OpendataContext) {}

  async run(): Promise<number> {
    const db = await this.ctx.db();
    const coverage = await new CoverageAnalyzer(db, this.ctx.catalog).analyze();
    const checks = await new ImportVerifier(db).verify(coverage);
    const report = verificationReport(checks, coverage);
    const saved = this.ctx.reports.save('verify', report);
    console.log(report.markdown);
    this.ctx.log.info(saved, 'verification report saved');
    return checks.some((c) => !c.ok && c.severity === 'error') ? 1 : 0;
  }
}

/** report — покрытие базы: категории, регионы, наборы, сведения, документы, карантин. */
export class ReportCommand implements CliCommand {
  readonly name = 'report';
  readonly usage = 'report — покрытие базы по категориям, регионам и источникам';

  constructor(private readonly ctx: OpendataContext) {}

  async run(): Promise<number> {
    const coverage = await new CoverageAnalyzer(await this.ctx.db(), this.ctx.catalog).analyze();
    const report = coverageReport(coverage);
    const saved = this.ctx.reports.save('coverage', report);
    console.log(report.markdown);
    this.ctx.log.info(saved, 'coverage report saved');
    return 0;
  }
}
