import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';

/** 7zz — официальная сборка 7-Zip (brew install sevenzip), 7z и 7za — p7zip (apk add p7zip, brew install p7zip). */
const CANDIDATES = ['7zz', '7z', '7za'] as const;

export class SevenZipNotFoundError extends Error {
  constructor(candidates: readonly string[]) {
    super(`7-Zip не найден (искали: ${candidates.join(', ')}). Установите p7zip: apk add p7zip, apt install p7zip-full или brew install p7zip`);
    this.name = 'SevenZipNotFoundError';
  }
}

/** Чтение 7z-архивов Росаккредитации внешним 7-Zip без распаковки на диск. */
export class SevenZip {
  constructor(readonly bin: string) {}

  /** Первый установленный бинарник 7-Zip. */
  static detect(candidates: readonly string[] = CANDIDATES): SevenZip {
    const found = candidates.find((bin) => !spawnSync(bin, ['i'], { stdio: 'ignore' }).error);
    if (!found) throw new SevenZipNotFoundError(candidates);
    return new SevenZip(found);
  }

  /** Файлы внутри архива (без папок). */
  list(file: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, ['l', '-slt', '-ba', file]);
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('error', (e) => reject(new Error(`${this.bin}: ${e.message}`)));
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`${this.bin} l ${file}: код ${code} ${err.trim()}`));
        const names = [...out.matchAll(/^Path = (.+)$/gm)].map((m) => m[1].trim());
        const dirs = new Set([...out.matchAll(/^Path = (.+)\r?\nFolder = \+/gm)].map((m) => m[1].trim()));
        resolve(names.filter((n) => !dirs.has(n)));
      });
    });
  }

  /** Поток одного файла из архива. */
  async streamEntry(file: string, entry: string, onStream: (s: Readable) => Promise<void>): Promise<void> {
    const p = spawn(this.bin, ['x', '-so', file, entry]);
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    const exited = new Promise<number>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => resolve(code ?? 0));
    });
    await onStream(p.stdout);
    const code = await exited;
    if (code !== 0) throw new Error(`${this.bin} x ${file} ${entry}: код ${code} ${err.trim()}`);
  }
}
