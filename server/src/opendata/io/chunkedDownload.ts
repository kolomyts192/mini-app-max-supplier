import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../logger';
import { sleep } from '../../sources/resilience';

const UA = 'proveren-postavshik/1.0 (+open data import)';

/** Файл на сервере: адрес, размер и поддержка Range. */
export interface RemoteFile {
  url: string;
  size: number;
  resumable: boolean;
}

interface ChunkState {
  url: string;
  size: number;
  chunkSize: number;
  done: number[];
}

export interface ChunkedOptions {
  chunkSize?: number;
  parallel?: number;
  attempts?: number;
}

/**
 * Загрузка большого файла фрагментами через Range: каждый фрагмент — отдельный запрос со строгой проверкой длины,
 * запись по своему смещению. Длинный поток с file.nalog.ru иногда приходит с пропуском и обрывается,
 * а фрагмент либо приходит целиком, либо повторяется. Готовые фрагменты помнятся в <файл>.chunks.json,
 * поэтому прерванная загрузка продолжается с места остановки.
 */
export class ChunkedDownload {
  private readonly chunkSize: number;
  private readonly parallel: number;
  private readonly attempts: number;
  private readonly stateFile: string;
  private state: ChunkState;

  constructor(
    private readonly remote: RemoteFile,
    private readonly part: string,
    private readonly log: Logger,
    opts: ChunkedOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? 32 * 1024 * 1024;
    this.parallel = opts.parallel ?? 4;
    this.attempts = opts.attempts ?? 6;
    this.stateFile = `${part}.chunks.json`;
    this.state = this.load();
  }

  get chunks(): number {
    return Math.ceil(this.remote.size / this.chunkSize);
  }

  /** Докачивает недостающие фрагменты. */
  async run(): Promise<void> {
    const done = new Set(this.state.done);
    const queue = [...Array(this.chunks).keys()].filter((i) => !done.has(i));
    if (!queue.length) return;
    const fd = fs.openSync(this.part, fs.existsSync(this.part) ? 'r+' : 'w+');
    try {
      fs.ftruncateSync(fd, this.remote.size);
      let nextLog = 0;
      const worker = async () => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
          const buf = await this.fetchChunk(i);
          fs.writeSync(fd, buf, 0, buf.length, i * this.chunkSize);
          done.add(i);
          this.save([...done]);
          const pct = Math.floor((done.size / this.chunks) * 100);
          if (pct >= nextLog) {
            this.log.info({ file: path.basename(this.part, '.part'), pct, mb: Math.round((done.size * this.chunkSize) / 1048576) }, 'downloading');
            nextLog = pct + 5;
          }
        }
      };
      await Promise.all(Array.from({ length: this.parallel }, worker));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Помечает фрагменты, пересекающие диапазоны [начало, конец), как не скачанные. Возвращает их число. */
  invalidate(ranges: [number, number][]): number {
    const bad = new Set<number>();
    for (const [start, end] of ranges) {
      for (let i = Math.floor(start / this.chunkSize); i <= Math.floor((Math.min(end, this.remote.size) - 1) / this.chunkSize); i++) bad.add(i);
    }
    this.save(this.state.done.filter((i) => !bad.has(i)));
    return bad.size;
  }

  /** Загрузка завершена: состояние фрагментов больше не нужно. */
  finish(): void {
    fs.rmSync(this.stateFile, { force: true });
  }

  private async fetchChunk(i: number): Promise<Buffer> {
    const start = i * this.chunkSize;
    const end = Math.min(this.remote.size, start + this.chunkSize) - 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(this.remote.url, { headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(300_000) });
        if (res.status !== 206) throw new Error(`HTTP ${res.status} вместо 206`);
        if (!(res.headers.get('content-range') ?? '').startsWith(`bytes ${start}-${end}/`)) throw new Error(`неожиданный Content-Range: ${res.headers.get('content-range')}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== end - start + 1) throw new Error(`фрагмент ${i}: получено ${buf.length} байт из ${end - start + 1}`);
        return buf;
      } catch (err) {
        if (attempt >= this.attempts) throw err;
        this.log.warn({ chunk: i, attempt, err: (err as Error).message }, 'chunk download failed, retrying');
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
  }

  /** Состояние прошлой загрузки того же файла; без него .part считается пустым. */
  private load(): ChunkState {
    const fresh: ChunkState = { url: this.remote.url, size: this.remote.size, chunkSize: this.chunkSize, done: [] };
    if (!fs.existsSync(this.stateFile) || !fs.existsSync(this.part)) return fresh;
    const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as ChunkState;
    return saved.size === fresh.size && saved.chunkSize === fresh.chunkSize ? { ...saved, url: fresh.url } : fresh;
  }

  private save(done: number[]): void {
    this.state = { ...this.state, done: done.sort((a, b) => a - b) };
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.stateFile);
  }
}
