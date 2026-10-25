/**
 * Импорт официальных открытых данных: npm run opendata -- <команда> [аргументы]
 * (в Docker: node dist/opendata/cli.js <команда>). Без команды — all.
 */
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { AnalyzeCommand } from './commands/analyzeCommand';
import type { CliCommand } from './commands/command';
import { DownloadCommand } from './commands/downloadCommand';
import { AllCommand, EnrichCommand, FsaCommand, ImportCommand, RnpCommand } from './commands/importCommands';
import { ReportCommand, VerifyCommand } from './commands/inspectCommands';
import { OpendataContext } from './context';

export function commands(ctx: OpendataContext): CliCommand[] {
  return [
    new DownloadCommand(ctx),
    new AnalyzeCommand(ctx),
    new ImportCommand(ctx),
    new EnrichCommand(ctx),
    new AllCommand(ctx),
    new FsaCommand(ctx),
    new RnpCommand(ctx),
    new VerifyCommand(ctx),
    new ReportCommand(ctx),
  ];
}

async function main(): Promise<number> {
  const [name = 'all', ...args] = process.argv.slice(2);
  const config = loadConfig();
  const ctx = new OpendataContext(config, createLogger(config.LOG_LEVEL));
  const available = commands(ctx);
  const command = available.find((c) => c.name === name);
  if (!command) {
    console.error(`Неизвестная команда «${name}». Команды:\n${available.map((c) => `  ${c.usage}`).join('\n')}`);
    return 2;
  }
  try {
    return await command.run(args);
  } finally {
    await ctx.close();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
