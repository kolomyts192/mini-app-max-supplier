/** Команда CLI открытых данных. Возвращает код завершения процесса. */
export interface CliCommand {
  readonly name: string;
  /** Строка справки: синтаксис и назначение. */
  readonly usage: string;
  run(args: string[]): Promise<number>;
}

/** Флаги вида --offline отделяются от позиционных аргументов. */
export function splitArgs(args: string[]): { positional: string[]; flags: Set<string> } {
  return {
    positional: args.filter((a) => !a.startsWith('--')),
    flags: new Set(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2))),
  };
}
