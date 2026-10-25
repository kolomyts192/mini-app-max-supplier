import zlib from 'node:zlib';
import yauzl from 'yauzl';

export interface ZipCheck {
  ok: boolean;
  entries: number;
  /** Файлы архива, у которых не сошлась контрольная сумма или не распаковались данные. */
  broken: string[];
}

/**
 * Проверка ZIP целиком: каждый файл распаковывается и сверяется с CRC32 из каталога архива.
 * Совпадение размера не гарантирует целостность — например, если файл дописывали два процесса.
 */
export class ZipVerifier {
  async check(file: string): Promise<ZipCheck> {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) => (err || !z ? reject(err) : resolve(z))),
    );
    const broken: string[] = [];
    let entries = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        entries += 1;
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            broken.push(entry.fileName);
            return zip.readEntry();
          }
          let crc = 0;
          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            if (!ok) broken.push(entry.fileName);
            zip.readEntry();
          };
          stream.on('data', (chunk: Buffer) => (crc = zlib.crc32(chunk, crc)));
          stream.on('error', () => finish(false));
          stream.on('end', () => finish(crc >>> 0 === entry.crc32 >>> 0));
        });
      });
      zip.readEntry();
    });
    return { ok: broken.length === 0, entries, broken };
  }
}
