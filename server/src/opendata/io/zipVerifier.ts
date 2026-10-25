import zlib from 'node:zlib';
import yauzl from 'yauzl';

export interface ZipCheck {
  ok: boolean;
  entries: number;
  /** Файлы архива, у которых не сошлась контрольная сумма или не распаковались данные. */
  broken: string[];
  /** Байтовые диапазоны [начало, конец) битых файлов в архиве — чтобы перекачать только их. */
  brokenRanges: [number, number][];
}

/** Запас на локальный заголовок файла в ZIP: 30 байт + имя + дополнительные поля. */
const LOCAL_HEADER_MARGIN = 64 * 1024;

/**
 * Проверка ZIP целиком: каждый файл распаковывается и сверяется с CRC32 из каталога архива.
 * Совпадение размера не гарантирует целостность: сервер может отдать поток с пропуском и оборвать его,
 * а докачка «склеит» файл правильной длины с неправильным содержимым.
 */
export class ZipVerifier {
  async check(file: string): Promise<ZipCheck> {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) => (err || !z ? reject(err) : resolve(z))),
    );
    const broken: string[] = [];
    const brokenRanges: [number, number][] = [];
    let entries = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        entries += 1;
        const fail = () => {
          broken.push(entry.fileName);
          brokenRanges.push([entry.relativeOffsetOfLocalHeader, entry.relativeOffsetOfLocalHeader + LOCAL_HEADER_MARGIN + entry.compressedSize]);
        };
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            fail();
            return zip.readEntry();
          }
          let crc = 0;
          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            if (!ok) fail();
            zip.readEntry();
          };
          stream.on('data', (chunk: Buffer) => (crc = zlib.crc32(chunk, crc)));
          stream.on('error', () => finish(false));
          stream.on('end', () => finish(crc >>> 0 === entry.crc32 >>> 0));
        });
      });
      zip.readEntry();
    });
    return { ok: broken.length === 0, entries, broken, brokenRanges };
  }
}
