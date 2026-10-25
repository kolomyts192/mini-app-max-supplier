import fs from 'node:fs';
import path from 'node:path';

/** Отчёт в двух видах: машинный JSON и человекочитаемый Markdown. */
export interface Report {
  json: unknown;
  markdown: string;
}

/** Папка отчётов диагностики, импорта и проверки базы: <имя>-<время>.json и .md рядом. */
export class ReportStore {
  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(name: string, report: Report): { json: string; markdown: string } {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const json = path.join(this.dir, `${name}-${stamp}.json`);
    const markdown = path.join(this.dir, `${name}-${stamp}.md`);
    fs.writeFileSync(json, JSON.stringify(report.json, null, 2));
    fs.writeFileSync(markdown, report.markdown);
    return { json, markdown };
  }
}
