import type { ImportResult } from './domain/importResult';
import type { Report } from './io/reportStore';

/** Итог служебного шага после импорта: пересчёт признаков, статистика БД. */
export interface PostStepResult {
  name: string;
  elapsedSec: number;
  details: Record<string, unknown>;
}

const STATUS_LABEL: Record<ImportResult['status'], string> = { ok: 'загружен', skipped: 'пропущен', failed: 'ошибка' };
const n = (v: number) => v.toLocaleString('ru-RU');

/** Один запуск импорта: результаты этапов по порядку и итоговый отчёт. */
export class ImportRun {
  readonly startedAt: Date;
  private finishedAt: Date | null = null;
  private readonly stageResults: ImportResult[] = [];
  private readonly stepResults: PostStepResult[] = [];

  constructor(
    readonly command: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = now();
  }

  addStage(result: ImportResult): void {
    this.stageResults.push(result);
  }

  addStep(result: PostStepResult): void {
    this.stepResults.push(result);
  }

  finish(): void {
    this.finishedAt = this.now();
  }

  get results(): readonly ImportResult[] {
    return this.stageResults;
  }

  get failed(): boolean {
    return this.stageResults.some((r) => r.status === 'failed');
  }

  get succeeded(): boolean {
    return this.stageResults.some((r) => r.status === 'ok');
  }

  get elapsedSec(): number {
    return Math.round(((this.finishedAt ?? this.now()).getTime() - this.startedAt.getTime()) / 1000);
  }

  report(): Report {
    const json = {
      command: this.command,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString() ?? null,
      elapsedSec: this.elapsedSec,
      failed: this.failed,
      stages: this.stageResults,
      postSteps: this.stepResults,
    };
    const notes = this.stageResults.filter((r) => r.message);
    const markdown = [
      `# Импорт открытых данных: \`${this.command}\``,
      '',
      `- Начат: ${this.startedAt.toISOString()}, длительность ${this.elapsedSec} с`,
      `- Итог: ${this.failed ? '**есть ошибки**' : 'без ошибок'}`,
      '',
      '| Этап | Набор | Статус | Дата данных | Записей | Совпало | Записано | Карантин | Время, с |',
      '|---|---|---|---|---:|---:|---:|---:|---:|',
      ...this.stageResults.map((r) => `| ${r.stage} | ${r.title} | ${STATUS_LABEL[r.status]} | ${r.dataDate ?? '—'} | ${n(r.rowsTotal)} | ${n(r.rowsMatched)} | ${n(r.written)} | ${n(r.quarantined)} | ${r.elapsedSec} |`),
      '',
      ...(notes.length ? ['## Замечания', '', ...notes.map((r) => `- ${r.stage}: ${r.message}`), ''] : []),
      ...(this.stepResults.length ? ['## После импорта', '', ...this.stepResults.map((s) => `- ${s.name} (${s.elapsedSec} с): ${JSON.stringify(s.details)}`), ''] : []),
    ].join('\n');
    return { json, markdown };
  }
}
