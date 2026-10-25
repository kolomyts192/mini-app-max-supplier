import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { FNS } from '../src/opendata/datasets/openDatasets';
import type { Company } from '../src/opendata/domain/company';
import { type ImportResult, skippedResult } from '../src/opendata/domain/importResult';
import { ImportCoordinator, type PostImportStep } from '../src/opendata/importCoordinator';
import type { DatasetImporter } from '../src/opendata/importers/datasetImporter';
import { bindToSuppliers } from '../src/opendata/importers/datasetImporter';
import type { SupplierIndexProvider } from '../src/opendata/importers/enrichmentImporter';
import { DebtImporter, TaxRegimeImporter } from '../src/opendata/importers/fnsEnrichment';
import { ImporterFactory } from '../src/opendata/importers/importerFactory';
import { RsmpRowMapper } from '../src/opendata/importers/rsmpRowMapper';
import { ImportRun } from '../src/opendata/importRun';
import { DatasetCache } from '../src/opendata/io/datasetCache';
import { DatasetDownloader } from '../src/opendata/io/downloader';
import { ZipVerifier } from '../src/opendata/io/zipVerifier';
import { OfficialSupplierIndex } from '../src/opendata/persistence/importLog';
import { SupplierBatchWriter, type SupplierWriteRow } from '../src/opendata/persistence/supplierBatchWriter';
import { TransactionRunner } from '../src/opendata/persistence/transactionRunner';
import { CompanyValidator } from '../src/opendata/validation/companyValidator';
import { Quarantine } from '../src/opendata/validation/quarantine';
import { catalog, silentLog } from './helpers';

function company(over: Partial<Company> = {}): Company {
  return {
    inn: '7707083893',
    ogrn: '1027700132195',
    name: 'ООО «Тест»',
    fullName: 'ООО «Тест»',
    entityType: 'LEGAL_ENTITY',
    sme: 'SMALL',
    includedAt: '2016-08-10',
    employees: 12,
    regionCode: '77',
    regionName: 'Москва',
    city: null,
    okvedMain: { code: '25.94', name: 'Производство крепежных изделий' },
    okvedAdd: [],
    declared: [],
    categories: ['fasteners'],
    products: [],
    okvedProducts: [],
    matchedBy: { okved: ['fasteners'], declared: [] },
    ...over,
  };
}

const supplierRow = (inn: string, ogrn: string | null): SupplierWriteRow => ({
  inn, ogrn, name: inn, shortName: inn, entityType: 'LEGAL_ENTITY', regionCode: '77', regionName: 'Москва', city: null, address: 'Москва',
  okvedMain: { code: '25.94', name: '' }, okvedAdditional: [], smeStatus: 'SMALL', supplierType: 'UNKNOWN', supplierTypeConfidence: 0.2,
  supplierTypeBasis: '', checkedAt: '2026-10-10T00:00:00Z', registrySeenAt: '2026-10-10', declaredProducts: [],
});

describe('проверка реквизитов', () => {
  const v = new CompanyValidator();

  it('контрольные цифры ИНН и ОГРН', () => {
    expect(CompanyValidator.innValid('7707083893')).toBe(true);
    expect(CompanyValidator.innValid('7707083890')).toBe(false);
    expect(CompanyValidator.innValid('500100732259')).toBe(true);
    expect(CompanyValidator.innValid('500100732258')).toBe(false);
    expect(CompanyValidator.ogrnValid('1027700132195')).toBe(true);
    expect(CompanyValidator.ogrnValid('1027700132194')).toBe(false);
    expect(CompanyValidator.ogrnValid('318253600000105')).toBe(true);
  });

  it('корректная компания без замечаний; ОГРН необязателен', () => {
    expect(v.validate(company())).toEqual([]);
    expect(v.validate(company({ ogrn: null }))).toEqual([]);
  });

  it('длина реквизитов зависит от вида лица', () => {
    const ip = company({ entityType: 'IP', inn: '7707083893', ogrn: '1027700132195', name: 'ИП Иванов' });
    expect(v.validate(ip).map((i) => i.field)).toEqual(['inn', 'ogrn']);
    expect(v.validate(company({ entityType: 'IP', inn: '500100732259', ogrn: '318253600000105', name: 'ИП Иванов' }))).toEqual([]);
  });

  it('пустые ИНН, регион и наименование', () => {
    const issues = v.validate(company({ inn: '', regionCode: '', name: 'ИП' }));
    expect(issues.map((i) => i.reason)).toEqual(['нет ИНН', 'нет кода региона', 'нет наименования']);
  });
});

describe('подготовка батча поставщиков', () => {
  it('повтор ИНН — остаётся последняя запись, ОГРН другого ИНН обнуляется', () => {
    const p = SupplierBatchWriter.prepare([
      supplierRow('7707083893', '1027700132195'),
      { ...supplierRow('7707083893', '1027700132195'), name: 'новое имя' },
      supplierRow('5031000000', '1027700132195'),
      supplierRow('7100000007', null),
    ]);
    expect(p.rows.map((r) => [r.inn, r.ogrn, r.name])).toEqual([
      ['7707083893', '1027700132195', 'новое имя'],
      ['5031000000', null, '5031000000'],
      ['7100000007', null, '7100000007'],
    ]);
    expect(p).toMatchObject({ duplicateInn: 1, ogrnConflicts: 1 });
  });
});

describe('строки реестра МСП', () => {
  const mapper = new RsmpRowMapper(catalog, { id: 'SME_REGISTRY', url: FNS.rsmp.passport, freshDays: 35 });

  it('продукция по ОКВЭД и по заявленной продукции, сведения с датой и сроком свежести', () => {
    const c = company({
      categories: ['fasteners', 'metal'],
      products: [{ productId: 'screws', categoryId: 'fasteners', title: 'Винты', code: '25.94.11.110' }],
      declared: [{ code: '25.94.11.110', name: 'Винты' }],
    });
    const rows = mapper.map([c], '2026-10-10');
    expect(rows.suppliers[0]).toMatchObject({ inn: c.inn, supplierType: 'MANUFACTURER', registrySeenAt: '2026-10-10', checkedAt: '2026-10-10T00:00:00Z' });
    expect(rows.products.map((p) => [p.categoryId, p.origin])).toEqual([['fasteners', 'SME_DECLARED'], ['metal', 'OKVED']]);
    const fields = rows.facts.map((f) => f.field);
    expect(fields).toEqual(['legal_status', 'okved_main', 'okved_additional', 'region', 'sme_status', 'sme_included_at', 'employees_count', 'declared_products', 'supplier_type']);
    expect(rows.facts[0].freshUntil).toBe('2026-11-14T00:00:00.000Z');
    expect(rows.facts[0].notes).toContain('10.10.2026');
  });

  it('привязка к id поставщика отбрасывает строки без поставщика', () => {
    const bound = bindToSuppliers([{ inn: 'a', x: 1 }, { inn: 'b', x: 2 }] as never[], new Map([['a', 'id-a']]));
    expect(bound).toEqual([{ x: 1, supplierId: 'id-a' }]);
  });
});

/** Фейковое соединение: запоминает запросы и параметры вместо записи в PostgreSQL. */
class RecordingClient {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
  release() {}
  inserted(): Record<string, unknown>[] {
    return this.queries.filter((q) => q.sql.includes('INSERT INTO verification_records')).flatMap((q) => JSON.parse(q.params[0] as string));
  }
}

function enrichmentDeps(dir: string, index: OfficialSupplierIndex) {
  const client = new RecordingClient();
  const db = { connect: async () => client as unknown as PoolClient } as never;
  return {
    client,
    deps: {
      cache: new DatasetCache(dir),
      runner: new TransactionRunner(db, silentLog),
      suppliers: { get: async () => index } as unknown as SupplierIndexProvider,
      log: silentLog,
    },
  };
}

describe('наборы обогащения', () => {
  const index = OfficialSupplierIndex.of([
    ['7707083893', 'id-ul-1'],
    ['5031000000', 'id-ul-2'],
    ['500100732259', 'id-ip'],
  ]);

  it('набор не скачан — этап пропускается с подсказкой', async () => {
    const { deps } = enrichmentDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'od-')), index);
    const r = await new DebtImporter(deps).run();
    expect(r).toMatchObject({ status: 'skipped', stage: 'debtam' });
    expect(r.message).toContain('opendata download debtam');
  });

  it('задолженность: сумма по документам, «нет в наборе» для остальных юрлиц, ИП не затрагиваются', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-'));
    const zip = path.resolve(__dirname, 'fixtures/debtam.zip');
    new DatasetCache(dir).saveLatest('debtam', { file: zip, dataDate: '2026-09-25', url: 'https://example/debtam.zip' });
    const { deps, client } = enrichmentDeps(dir, index);
    const r = await new DebtImporter(deps).run();
    expect(r).toMatchObject({ status: 'ok', rowsTotal: 3, rowsMatched: 2, written: 2, dataDate: '2026-09-25' });
    const facts = client.inserted();
    expect(facts.map((f) => [f.supplier_id, String(f.value).replace(/\s/g, ' ')])).toEqual([
      ['id-ul-1', '1 500,5 ₽'],
      ['id-ul-2', 'Нет в наборе задолженностей'],
    ]);
    expect(facts[0]).toMatchObject({ field: 'tax_debt', source: 'FNS_PB', checked_at: '2026-09-25T00:00:00Z' });
    const del = client.queries.find((q) => q.sql.includes('DELETE FROM verification_records'))!;
    expect(del.params).toEqual(['tax_debt', 'FNS_PB', 'LEGAL_ENTITY']);
    expect(client.queries.map((q) => q.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'DELETE', 'INSERT', 'DELETE', 'INSERT', 'COMMIT']);
  });

  it('спецрежимы юрлиц: нет в наборе — ОСН', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-'));
    new DatasetCache(dir).saveLatest('snr', { file: path.resolve(__dirname, 'fixtures/debtam.zip'), dataDate: '2026-09-25', url: 'u' });
    const { deps, client } = enrichmentDeps(dir, index);
    await new TaxRegimeImporter(deps).run();
    expect(client.inserted().map((f) => f.value)).toEqual(['ОСН (специальный режим не применяется)', 'ОСН (специальный режим не применяется)']);
  });
});

class StubImporter implements DatasetImporter {
  calls = 0;
  constructor(
    readonly stage: string,
    readonly group: DatasetImporter['group'],
    private readonly outcome: 'ok' | 'fail',
  ) {}
  get title() {
    return this.stage;
  }
  async run(): Promise<ImportResult> {
    this.calls += 1;
    if (this.outcome === 'fail') throw new Error(`${this.stage} сломался`);
    return { ...skippedResult(this.stage, this.stage, ''), status: 'ok', message: undefined, written: 10 };
  }
}

describe('координатор импорта', () => {
  const step: PostImportStep & { calls: number } = { name: 'шаг', calls: 0, async run() { this.calls += 1; return { ok: true }; } };

  it('ошибка набора обогащения не останавливает остальные', async () => {
    const run = await new ImportCoordinator([new StubImporter('sshr', 'enrichment', 'fail'), new StubImporter('snr', 'enrichment', 'ok')], [step], silentLog).run(new ImportRun('test'));
    expect(run.results.map((r) => r.status)).toEqual(['failed', 'ok']);
    expect(run.failed).toBe(true);
    expect(step.calls).toBe(1);
  });

  it('ошибка служебного шага попадает в отчёт, а не обрывает запуск', async () => {
    const broken: PostImportStep = { name: 'VACUUM', run: async () => { throw new Error('No space left on device'); } };
    const run = await new ImportCoordinator([new StubImporter('sshr', 'enrichment', 'ok')], [broken, step], silentLog).run(new ImportRun('test'));
    expect(run.failed).toBe(true);
    expect(run.report().markdown).toContain('**ошибка** VACUUM');
    expect(step.calls).toBe(2);
  });

  it('ошибка реестра МСП останавливает запуск', async () => {
    const next = new StubImporter('sshr', 'enrichment', 'ok');
    const run = await new ImportCoordinator([new StubImporter('rsmp', 'registry', 'fail'), next], [], silentLog).run(new ImportRun('test'));
    expect(next.calls).toBe(0);
    expect(run.results[1]).toMatchObject({ status: 'skipped', message: 'не выполнялся: ошибка этапа rsmp' });
  });

  it('отчёт запуска: таблица этапов и замечания', () => {
    const run = new ImportRun('opendata import', () => new Date('2026-10-25T10:00:00Z'));
    run.addStage(skippedResult('rnp', 'РНП', 'нет CSV'));
    run.finish();
    const { markdown, json } = run.report();
    expect(markdown).toContain('| rnp | РНП | пропущен |');
    expect(markdown).toContain('- rnp: нет CSV');
    expect(json).toMatchObject({ command: 'opendata import', failed: false });
  });
});

describe('выбор этапов и загрузка', () => {
  it('группы раскрываются в порядке выполнения, неизвестный этап — ошибка', () => {
    expect(ImporterFactory.resolve(['fns'])).toEqual(['rsmp', 'sshr', 'snr', 'snrip', 'debtam', 'paytax', 'taxoffence', 'rsmppp', 'revexp']);
    expect(ImporterFactory.resolve(['fsa-rds', 'rsmp', 'fsa'])).toEqual(['rsmp', 'fsa-rss', 'fsa-rds']);
    expect(() => ImporterFactory.resolve(['egrul'])).toThrow(/Неизвестный этап «egrul»/);
  });

  it('свежая версия из паспорта: даты ГГГГММДД и ДДММГГГГ', () => {
    const v = DatasetDownloader.newestLink([
      'data-10092026-structure-12052026.zip,https://www.nalog.gov.ru/opendata/7707329152-rsmp/data-10092026-structure-12052026.zip',
      'https://file.nalog.ru/opendata/7707329152-rsmp/data-10102026-structure-12052026.zip',
      'https://x/opendata/a/data-20260901-structure-20250101.csv',
    ]);
    expect(v).toEqual({ url: 'https://file.nalog.ru/opendata/7707329152-rsmp/data-10102026-structure-12052026.zip', dataDate: '2026-10-10', structure: '12052026' });
    expect(DatasetDownloader.newestLink(['нет ссылок'])).toBeNull();
  });

  it('архив проверяется по CRC32: испорченный байт находится, даже если размер совпал', async () => {
    const good = path.resolve(__dirname, 'fixtures/debtam.zip');
    expect(await new ZipVerifier().check(good)).toEqual({ ok: true, entries: 1, broken: [], brokenRanges: [] });
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'od-')), 'debtam.zip');
    const bytes = fs.readFileSync(good);
    bytes[120] ^= 0xff;
    fs.writeFileSync(bad, bytes);
    const check = await new ZipVerifier().check(bad);
    expect(check.ok).toBe(false);
    expect(check.broken).toEqual(['VO_DEBTAM_0001.xml']);
    expect(check.brokenRanges[0][0]).toBe(0);
  });

  it('карантин считает все записи, а хранит ограниченно и с обрезанным фрагментом', () => {
    const q = new Quarantine('rsmp');
    q.add('нет ИНН', null, 'x'.repeat(5000));
    q.add('нет ИНН', '', 'y');
    q.add('нет региона', '7707083893', 'z');
    expect(q.count).toBe(3);
    expect(q.reasons()).toEqual({ 'нет ИНН': 2, 'нет региона': 1 });
    expect(q.entries[0].payload).toHaveLength(4000);
    expect(q.entries[1].inn).toBeNull();
  });

  it('временные ошибки БД повторяются, ошибки данных — нет', () => {
    expect(TransactionRunner.isTransient({ code: '40P01' })).toBe(true);
    expect(TransactionRunner.isTransient({ code: 'ECONNRESET' })).toBe(true);
    expect(TransactionRunner.isTransient(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(TransactionRunner.isTransient({ code: '23505' })).toBe(false);
  });
});

describe('даты в выдаче', () => {
  it('дата реестра МСП и самая свежая дата налоговых наборов; реестр поддержки МСП налогами не считается', async () => {
    const { searchDates } = await import('../src/search/service');
    const imp = (dataset: string, source: string, dataDate: string) => ({ dataset, source, title: dataset, dataDate, rowsMatched: 1 });
    expect(searchDates([imp('rsmp', 'SME_REGISTRY', '2026-10-10'), imp('sshr', 'FNS_PB', '2026-09-25'), imp('paytax', 'FNS_PB', '2026-04-01'), imp('rsmppp', 'SME_SUPPORT', '2026-10-15')]))
      .toEqual({ registryDate: '2026-10-10', factsDate: '2026-09-25' });
    expect(searchDates([])).toEqual({ registryDate: null, factsDate: null });
  });
});
