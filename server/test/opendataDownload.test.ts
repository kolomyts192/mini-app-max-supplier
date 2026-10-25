import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChunkedDownload } from '../src/opendata/io/chunkedDownload';
import { DatasetDownloader } from '../src/opendata/io/downloader';
import { silentLog } from './helpers';

const MB = 1024 * 1024;

/** Сервер с поддержкой Range, который по команде обрывает ответ посреди фрагмента — как file.nalog.ru. */
class FlakyServer {
  readonly files = new Map<string, Buffer>();
  readonly requests: string[] = [];
  /** Сколько ближайших ответов на этот диапазон оборвать. */
  readonly breakNext = new Map<string, number>();
  private server!: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const body = this.files.get(req.url ?? '');
      if (!body) return res.writeHead(404).end();
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (!m) return res.writeHead(200, { 'content-length': body.length }).end(body);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      const range = `${start}-${end}`;
      this.requests.push(range);
      res.writeHead(206, { 'content-range': `bytes ${range}/${body.length}`, 'content-length': end - start + 1 });
      const broken = this.breakNext.get(range) ?? 0;
      if (broken > 0) {
        this.breakNext.set(range, broken - 1);
        res.write(body.subarray(start, start + Math.floor((end - start) / 2)));
        return void res.socket?.destroy();
      }
      res.end(body.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('загрузка фрагментами', () => {
  const server = new FlakyServer();
  const data = crypto.randomBytes(Math.round(3.5 * MB));
  let base = '';

  beforeAll(async () => {
    server.files.set('/big.bin', data);
    server.files.set('/debtam.zip', fs.readFileSync(path.resolve(__dirname, 'fixtures/debtam.zip')));
    base = await server.start();
  });

  afterAll(() => server.stop());

  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'od-dl-'));

  it('оборванный фрагмент повторяется, файл собирается байт в байт', async () => {
    server.breakNext.set(`${2 * MB}-${3 * MB - 1}`, 1);
    const part = path.join(tmp(), 'big.bin.part');
    const d = new ChunkedDownload({ url: `${base}/big.bin`, size: data.length, resumable: true }, part, silentLog, { chunkSize: MB, parallel: 2 });
    await d.run();
    expect(fs.readFileSync(part).equals(data)).toBe(true);
    expect(server.requests.filter((r) => r === `${2 * MB}-${3 * MB - 1}`)).toHaveLength(2);
    expect(fs.existsSync(`${part}.chunks.json`)).toBe(true);
    d.finish();
    expect(fs.existsSync(`${part}.chunks.json`)).toBe(false);
  });

  it('повреждённый участок перекачивается только своим фрагментом', async () => {
    const part = path.join(tmp(), 'big.bin.part');
    const remote = { url: `${base}/big.bin`, size: data.length, resumable: true };
    await new ChunkedDownload(remote, part, silentLog, { chunkSize: MB }).run();
    const fd = fs.openSync(part, 'r+');
    fs.writeSync(fd, Buffer.alloc(1000, 0), 0, 1000, Math.round(1.5 * MB));
    fs.closeSync(fd);

    server.requests.length = 0;
    const again = new ChunkedDownload(remote, part, silentLog, { chunkSize: MB });
    expect(again.invalidate([[Math.round(1.5 * MB), Math.round(1.5 * MB) + 1000]])).toBe(1);
    await again.run();
    expect(server.requests).toEqual([`${MB}-${2 * MB - 1}`]);
    expect(fs.readFileSync(part).equals(data)).toBe(true);
  });

  it('загрузчик: ZIP скачивается, проверяется по CRC32 и повторно не качается', async () => {
    const dest = path.join(tmp(), 'debtam.zip');
    const downloader = new DatasetDownloader(silentLog, { mirrors: [] });
    await downloader.download(`${base}/debtam.zip`, dest);
    expect(fs.readFileSync(dest).equals(server.files.get('/debtam.zip')!)).toBe(true);
    expect(fs.existsSync(`${dest}.verified`)).toBe(true);
    server.requests.length = 0;
    await downloader.download(`${base}/debtam.zip`, dest);
    expect(server.requests).toEqual(['0-0']);
  });
});
