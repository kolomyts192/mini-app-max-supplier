import fs from 'node:fs';
import path from 'node:path';

/** Метаданные последней скачанной версии набора. */
export interface LatestFile {
  file: string;
  dataDate: string;
  url: string;
}

/** Путь к файлу набора в кэше: <dir>/<dataset>/<имя из URL>. */
export function cachePath(dir: string, id: string, url: string): string {
  return path.join(dir, id, path.basename(new URL(url).pathname));
}

/** Последняя версия набора, если файл ещё существует на диске. */
export function readLatest(dir: string, id: string): LatestFile | null {
  const manifest = path.join(dir, id, 'latest.json');
  if (!fs.existsSync(manifest)) return null;
  const meta = JSON.parse(fs.readFileSync(manifest, 'utf8')) as LatestFile;
  return fs.existsSync(meta.file) ? meta : null;
}

/** Атомарно сохраняет манифест последней версии набора. */
export function writeLatest(dir: string, id: string, meta: LatestFile): void {
  const manifest = path.join(dir, id, 'latest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const tmp = `${manifest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, manifest);
}
