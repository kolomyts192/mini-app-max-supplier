import fs from 'node:fs';
import path from 'node:path';

/** Метаданные последней скачанной версии набора. */
export interface LatestFile {
  file: string;
  dataDate: string;
  url: string;
}

/**
 * Кэш архивов открытых данных: <dir>/<набор>/<имя файла из URL> и манифест latest.json
 * с последней скачанной версией.
 */
export class DatasetCache {
  constructor(readonly dir: string) {}

  folder(id: string): string {
    return path.join(this.dir, id);
  }

  /** Путь к файлу набора: <dir>/<набор>/<имя из URL>. */
  pathFor(id: string, url: string): string {
    return path.join(this.folder(id), path.basename(new URL(url).pathname));
  }

  /** Последняя версия набора, если файл ещё существует на диске. */
  latest(id: string): LatestFile | null {
    const manifest = this.manifest(id);
    if (!fs.existsSync(manifest)) return null;
    const meta = JSON.parse(fs.readFileSync(manifest, 'utf8')) as LatestFile;
    return fs.existsSync(meta.file) ? meta : null;
  }

  /** Атомарно сохраняет манифест последней версии набора. */
  saveLatest(id: string, meta: LatestFile): void {
    const manifest = this.manifest(id);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const tmp = `${manifest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, manifest);
  }

  private manifest(id: string): string {
    return path.join(this.folder(id), 'latest.json');
  }
}
