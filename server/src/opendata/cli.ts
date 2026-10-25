/**
 * Импорт официальных открытых данных.
 *   download [ids...]  — скачать свежие версии наборов ФНС в OPENDATA_DIR
 *   import             — разобрать архивы и загрузить реальных поставщиков в PostgreSQL
 *   all                — download + import
 *   rnp                — импорт РНП ФАС (нужен доступ к fas.gov.ru с российского IP)
 *   fsa [rds|rss]      — импорт деклараций и сертификатов Росаккредитации (нужен доступ к fsa.gov.ru с российского IP)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Catalog } from '../catalog/catalog';
import { loadConfig } from '../config';
import { createDb, runMigrations } from '../infra/db';
import { createLogger } from '../logger';
import { latestRsmp, renderAnalysis, RsmpAnalyzer, saveAnalysis } from './analyze';
import { cachePath, writeLatest } from './cache';
import { FNS_DATASETS } from './datasets';
import { downloadFile, latestFromPassport } from './download';

export async function downloadAll(dir: string, ids: string[], log: ReturnType<typeof createLogger>) {
  const out: Record<string, { file: string; dataDate: string; url: string }> = {};
  for (const ds of FNS_DATASETS.filter((d) => !ids.length || ids.includes(d.id))) {
    const latest = await latestFromPassport(ds.passport);
    const file = cachePath(dir, ds.id, latest.url);
    log.info({ dataset: ds.id, url: latest.url, dataDate: latest.dataDate }, 'dataset version');
    await downloadFile(latest.url, file, log);
    const meta = { file, dataDate: latest.dataDate, url: latest.url };
    out[ds.id] = meta;
    writeLatest(dir, ds.id, meta);
  }
  return out;
}

async function main() {
  const [cmd = 'all', ...args] = process.argv.slice(2);
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const dir = config.OPENDATA_DIR;
  fs.mkdirSync(dir, { recursive: true });

  if (cmd === 'analyze') {
    const catalog = Catalog.load(config.dataDir);
    const latest = latestRsmp(dir);
    const regions = config.OPENDATA_REGIONS ? new Set(config.OPENDATA_REGIONS.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const analysis = await new RsmpAnalyzer(catalog, log).analyze(latest.file, latest.dataDate, regions);
    const reports = path.resolve(config.dataDir, '..', 'reports');
    const saved = saveAnalysis(reports, analysis);
    console.log(renderAnalysis(analysis));
    log.info({ json: saved.json, markdown: saved.markdown, companies: analysis.uniqueCompanies }, 'rsmp analysis saved');
    return;
  }

  if (cmd === 'download' || cmd === 'all') await downloadAll(dir, cmd === 'download' ? args : [], log);

  if (cmd === 'import' || cmd === 'all' || cmd === 'rnp' || cmd === 'fsa') {
    const db = createDb(config.DATABASE_URL);
    try {
      await runMigrations(db, config.migrationsDir, log);
      const { importFns, importFasRnp, importFsa } = await import('./importer');
      if (cmd === 'rnp') await importFasRnp(db, dir, log);
      else if (cmd === 'fsa') {
        // fsa [rds|rss] [--offline]: --offline — архивы уже лежат в OPENDATA_DIR/fsa-<вид> (скачаны через браузер)
        const offline = args.includes('--offline');
        const kinds = args.filter((a) => a === 'rds' || a === 'rss') as ('rds' | 'rss')[];
        for (const kind of kinds.length ? kinds : (['rds', 'rss'] as const)) await importFsa(db, dir, log, kind, { offline });
      }
      // import enrich — только наборы численности/режимов/задолженности/доходов без повторного разбора реестра МСП
      else await importFns(db, dir, log, { regions: config.OPENDATA_REGIONS, only: cmd === 'import' && args.length ? args : undefined });
    } finally {
      await db.end();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
