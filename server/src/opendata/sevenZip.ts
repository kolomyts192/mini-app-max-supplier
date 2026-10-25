import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Файлы внутри 7z-архива (нужен 7z из пакета p7zip). */
export function list7z(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawn('7z', ['l', '-slt', '-ba', file]);
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => reject(new Error(`7z не найден: установите p7zip (${e.message})`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`7z l ${file}: код ${code} ${err.trim()}`));
      const names = [...out.matchAll(/^Path = (.+)$/gm)].map((m) => m[1].trim());
      const dirs = new Set([...out.matchAll(/^Path = (.+)\r?\nFolder = \+/gm)].map((m) => m[1].trim()));
      resolve(names.filter((n) => !dirs.has(n)));
    });
  });
}

/** Поток одного файла из 7z-архива без распаковки на диск. */
export async function stream7zEntry(file: string, entry: string, onStream: (s: Readable) => Promise<void>): Promise<void> {
  const p = spawn('7z', ['x', '-so', file, entry]);
  let err = '';
  p.stderr.on('data', (c) => (err += c));
  const exited = new Promise<number>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => resolve(code ?? 0));
  });
  await onStream(p.stdout);
  const code = await exited;
  if (code !== 0) throw new Error(`7z x ${file} ${entry}: код ${code} ${err.trim()}`);
}
