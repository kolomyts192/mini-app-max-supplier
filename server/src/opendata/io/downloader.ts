import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../../logger';
import { sleep } from '../../sources/resilience';
import { ZipVerifier } from './zipVerifier';

const UA = 'proveren-postavshik/1.0 (+open data import)';

/** Версия набора из паспорта: ссылка на файл и дата данных. */
export interface DatasetVersion {
  url: string;
  /** YYYY-MM-DD */
  dataDate: string;
  structure: string | null;
}

/**
 * Зеркала файлов открытых данных. www.nalog.gov.ru отдаёт файлы целиком (игнорирует Range) и рвёт соединение
 * через несколько минут, поэтому 2 ГБ реестра МСП оттуда не скачать; file.nalog.ru отдаёт те же файлы с докачкой.
 */
export const DEFAULT_MIRRORS: readonly { from: string; to: string }[] = [
  { from: 'https://www.nalog.gov.ru/opendata/', to: 'https://file.nalog.ru/opendata/' },
];

interface RemoteFile {
  url: string;
  size: number;
  resumable: boolean;
}

export interface DownloaderOptions {
  attempts?: number;
  mirrors?: readonly { from: string; to: string }[];
  /** Проверка ZIP по CRC32 после загрузки; null — не проверять. */
  verifier?: ZipVerifier | null;
}

/**
 * Загрузка наборов открытых данных: версия из паспорта, выбор зеркала, потоковая запись с докачкой (Range)
 * и повторами. Готовый файл повторно не скачивается.
 */
export class DatasetDownloader {
  private readonly attempts: number;
  private readonly mirrors: readonly { from: string; to: string }[];
  private readonly verifier: ZipVerifier | null;

  constructor(
    private readonly log: Logger,
    opts: DownloaderOptions = {},
  ) {
    this.attempts = opts.attempts ?? 8;
    this.mirrors = opts.mirrors ?? DEFAULT_MIRRORS;
    this.verifier = opts.verifier === undefined ? new ZipVerifier() : opts.verifier;
  }

  /**
   * Паспорт набора (стандарт opendata.gosmonitor.ru 3.0): meta.csv со ссылками на версии.
   * meta.csv бывает неполным или отстаёт от страницы паспорта, поэтому ссылки берём из обоих мест.
   */
  async latestVersion(passportUrl: string): Promise<DatasetVersion> {
    const base = passportUrl.replace(/\/?$/, '/');
    const texts: string[] = [];
    for (const url of [`${base}meta.csv`, base]) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
        if (res.ok) texts.push(await res.text());
      } catch {
        /* пробуем следующий */
      }
    }
    if (!texts.length) throw new Error(`Паспорт набора недоступен: ${base}`);
    const latest = DatasetDownloader.newestLink(texts);
    if (!latest) throw new Error(`В паспорте ${base} нет ссылок на данные`);
    return latest;
  }

  /** Самая свежая ссылка вида data-YYYYMMDD[-structure-YYYYMMDD].zip|csv|xml|gz (дата бывает и в формате DDMMYYYY). */
  static newestLink(texts: string[]): DatasetVersion | null {
    const links = texts.flatMap((t) => [...t.matchAll(/https?:\/\/[^\s",<>']+?data-(\d{8})(?:-structure-(\d{8}))?\.(?:zip|csv|xml|gz)/gi)]);
    const parse = (d: string) => (/^(19|20)\d{6}$/.test(d) ? d : `${d.slice(4)}${d.slice(2, 4)}${d.slice(0, 2)}`);
    const best = links
      .map((m) => ({ url: m[0], date: parse(m[1]), structure: m[2] ?? null }))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!best) return null;
    return { url: best.url, dataDate: `${best.date.slice(0, 4)}-${best.date.slice(4, 6)}-${best.date.slice(6, 8)}`, structure: best.structure };
  }

  /** Скачивает файл в dest (через dest.part). Возвращает путь к готовому файлу. */
  async download(url: string, dest: string): Promise<string> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const name = path.basename(dest);
    let remote: RemoteFile;
    try {
      remote = await this.resolve(url);
    } catch (err) {
      // Источник временно не отвечает, но эта версия уже скачана целиком — работаем с ней
      if (fs.existsSync(dest) && (await this.intact(dest))) {
        this.log.warn({ file: name, err: (err as Error).message }, 'source unavailable, using downloaded file');
        return dest;
      }
      throw err;
    }
    if (fs.existsSync(dest) && remote.size && fs.statSync(dest).size === remote.size) {
      if (await this.intact(dest)) {
        this.log.info({ file: name, mb: Math.round(remote.size / 1048576) }, 'already downloaded');
        return dest;
      }
      fs.renameSync(dest, `${dest}.broken`);
    }
    const part = `${dest}.part`;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        await this.fetchInto(remote, part);
        if (remote.size && fs.statSync(part).size !== remote.size) throw new Error('размер файла не совпал');
        if (!(await this.intact(part))) {
          fs.rmSync(part);
          throw new Error('архив повреждён: не сошлись контрольные суммы, скачиваю заново');
        }
        fs.renameSync(part, dest);
        fs.renameSync(`${part}.verified`, `${dest}.verified`);
        this.log.info({ file: name, url: remote.url }, 'download complete');
        return dest;
      } catch (err) {
        const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        this.log.warn({ file: name, attempt, mb: Math.round(have / 1048576), resumable: remote.resumable, err: (err as Error).message }, 'download failed, retrying');
        await sleep(Math.min(60_000, 2000 * 2 ** attempt));
      }
    }
    throw new Error(`Не удалось скачать ${url}`);
  }

  /**
   * Целостность ZIP по CRC32. Проверенный файл помечается <файл>.verified с его размером,
   * чтобы повторная загрузка не распаковывала гигабайты заново.
   */
  private async intact(file: string): Promise<boolean> {
    const marker = `${file}.verified`;
    const size = String(fs.statSync(file).size);
    if (!this.verifier || !/\.zip(\.part)?$/i.test(file)) {
      fs.writeFileSync(marker, size);
      return true;
    }
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === size) return true;
    const check = await this.verifier.check(file);
    if (!check.ok) {
      this.log.warn({ file: path.basename(file), entries: check.entries, broken: check.broken.length, sample: check.broken.slice(0, 3) }, 'zip archive is corrupted');
      return false;
    }
    fs.writeFileSync(marker, size);
    return true;
  }

  /** Первое зеркало, которое отдаёт файл с докачкой; иначе исходная ссылка. */
  private async resolve(url: string): Promise<RemoteFile> {
    const candidates = [...this.mirrors.filter((m) => url.startsWith(m.from)).map((m) => m.to + url.slice(m.from.length)), url];
    let fallback: RemoteFile | null = null;
    for (const candidate of candidates) {
      const probe = await this.probe(candidate).catch(() => null);
      if (!probe) continue;
      if (probe.resumable) return probe;
      fallback ??= probe;
    }
    if (!fallback) throw new Error(`Файл недоступен: ${url}`);
    return fallback;
  }

  /** Размер файла и поддержка Range: запрос одного байта. */
  private async probe(url: string): Promise<RemoteFile> {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(60_000) });
    await res.body?.cancel();
    if (res.status === 206) {
      const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
      return { url, size: Number(total ?? 0), resumable: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url, size: Number(res.headers.get('content-length') ?? 0), resumable: false };
  }

  private async fetchInto(remote: RemoteFile, part: string): Promise<void> {
    const have = remote.resumable && fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (remote.size && have === remote.size) return;
    const res = await fetch(remote.url, {
      headers: { 'User-Agent': UA, ...(have ? { Range: `bytes=${have}-` } : {}) },
      signal: AbortSignal.timeout(4 * 3600_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const append = res.status === 206 && have > 0;
    if (append) {
      // Докачка с другого байта сдвинула бы весь хвост архива
      const start = Number(/bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1]);
      if (start !== have) {
        await res.body?.cancel();
        throw new Error(`сервер начал докачку с байта ${start}, а не ${have}`);
      }
    }
    let done = append ? have : 0;
    let nextLog = 0;
    const name = path.basename(part, '.part');
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      done += chunk.length;
      const pct = remote.size ? Math.floor((done / remote.size) * 100) : 0;
      if (pct >= nextLog) {
        this.log.info({ file: name, pct, mb: Math.round(done / 1048576) }, 'downloading');
        nextLog = pct + 5;
      }
    });
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    const closed = new Promise<void>((resolve) => out.once('close', () => resolve()));
    try {
      await pipeline(body, out);
    } finally {
      // Следующая попытка докачивает с размера файла: ждём, пока все принятые куски окажутся на диске
      await closed;
    }
  }
}
