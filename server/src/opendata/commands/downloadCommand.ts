import type { OpendataContext } from '../context';
import { FNS_DATASETS } from '../datasets/openDatasets';
import type { LatestFile } from '../io/datasetCache';
import { DatasetDownloader } from '../io/downloader';
import type { CliCommand } from './command';

/** download [наборы...] — свежие версии наборов ФНС в OPENDATA_DIR; без аргументов — все девять. */
export class DownloadCommand implements CliCommand {
  readonly name = 'download';
  readonly usage = 'download [rsmp|sshr|snr|snrip|debtam|paytax|taxoffence|rsmppp|revexp ...] — скачать свежие версии наборов ФНС';

  constructor(
    private readonly ctx: OpendataContext,
    private readonly downloader = new DatasetDownloader(ctx.log),
  ) {}

  async run(args: string[]): Promise<number> {
    const { failed } = await this.downloadAll(args);
    return failed.length ? 1 : 0;
  }

  /** Один недоступный набор не мешает скачать остальные. */
  async downloadAll(ids: string[]): Promise<{ files: Record<string, LatestFile>; failed: string[] }> {
    const unknown = ids.filter((id) => !FNS_DATASETS.some((d) => d.id === id));
    if (unknown.length) throw new Error(`Неизвестные наборы: ${unknown.join(', ')}`);
    const files: Record<string, LatestFile> = {};
    const failed: string[] = [];
    for (const ds of FNS_DATASETS.filter((d) => !ids.length || ids.includes(d.id))) {
      try {
        const version = await this.downloader.latestVersion(ds.passport);
        this.ctx.log.info({ dataset: ds.id, url: version.url, dataDate: version.dataDate }, 'dataset version');
        const file = await this.downloader.download(version.url, this.ctx.cache.pathFor(ds.id, version.url));
        files[ds.id] = { file, dataDate: version.dataDate, url: version.url };
        this.ctx.cache.saveLatest(ds.id, files[ds.id]);
      } catch (err) {
        failed.push(ds.id);
        this.ctx.log.error({ dataset: ds.id, err: (err as Error).message }, 'dataset download failed');
      }
    }
    return { files, failed };
  }
}
