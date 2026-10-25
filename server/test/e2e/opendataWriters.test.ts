/**
 * Пакетная запись импорта на настоящем PostgreSQL: идемпотентность, конфликты ОГРН, области замены сведений.
 * Создаёт временную базу рядом с DATABASE_URL и удаляет её после тестов. Запуск: E2E=1 npm run test:e2e.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, runMigrations } from '../../src/infra/db';
import { freshness, type SupplierFact } from '../../src/opendata/domain/fact';
import { FactBatchWriter } from '../../src/opendata/persistence/factBatchWriter';
import { ProductBatchWriter } from '../../src/opendata/persistence/productBatchWriter';
import { SupplierBatchWriter, type SupplierWriteRow } from '../../src/opendata/persistence/supplierBatchWriter';
import { TransactionRunner } from '../../src/opendata/persistence/transactionRunner';
import { silentLog } from '../helpers';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://supplier:supplier@localhost:5432/supplier';
const TEST_DB = `supplier_writers_${process.pid}`;

const row = (inn: string, ogrn: string | null, over: Partial<SupplierWriteRow> = {}): SupplierWriteRow => ({
  inn, ogrn, name: `ООО «${inn}»`, shortName: `ООО «${inn}»`, entityType: inn.length === 12 ? 'IP' : 'LEGAL_ENTITY', regionCode: '77', regionName: 'Москва',
  city: null, address: 'Москва', okvedMain: { code: '25.94', name: 'Производство крепежных изделий' }, okvedAdditional: [], smeStatus: 'SMALL',
  supplierType: 'UNKNOWN', supplierTypeConfidence: 0.2, supplierTypeBasis: 'по ОКВЭД', checkedAt: '2026-10-10T00:00:00Z', registrySeenAt: '2026-10-10',
  declaredProducts: [], ...over,
});

const fact = (supplierId: string, field: string, value: string, source = 'SME_REGISTRY'): SupplierFact => ({
  supplierId, field, value, notes: null, source, sourceUrl: 'https://example', confidence: 0.99, ...freshness('2026-10-10', 35),
});

describe.skipIf(!process.env.E2E)('пакетная запись импорта (PostgreSQL)', () => {
  let admin: Pool;
  let db: Db;
  let runner: TransactionRunner;
  const suppliers = new SupplierBatchWriter();
  const products = new ProductBatchWriter();
  const facts = new FactBatchWriter();
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    db = createDb(BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
    await runMigrations(db, `${__dirname}/../../migrations`, silentLog);
    runner = new TransactionRunner(db, silentLog);
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin?.end();
  });

  it('повторная запись того же батча не создаёт дублей и сохраняет id', async () => {
    const batch = SupplierBatchWriter.prepare([row('7707083893', '1027700132195'), row('500100732259', '318253600000105')]).rows;
    const write = () =>
      runner.run('test', async (client) => {
        const ids = await suppliers.upsert(client, batch);
        const list = [...ids.values()];
        await products.replace(client, list, list.map((supplierId) => ({ supplierId, categoryId: 'fasteners', productId: null, title: 'ОКВЭД', okpd2: null, origin: 'OKVED' as const, source: 'SME_REGISTRY', sourceUrl: 'u', checkedAt: '2026-10-10T00:00:00Z' })));
        await facts.replaceForSuppliers(client, 'SME_REGISTRY', list, list.map((id) => fact(id, 'region', '77')));
        return ids;
      });
    const first = await write();
    const second = await write();
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(await count(`SELECT count(*) AS n FROM suppliers`)).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM product_records`)).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM verification_records`)).toBe(2);
    const r = await db.query(`SELECT short_name, entity_type, legal_status, source_type, registry_seen_at FROM suppliers WHERE inn = '7707083893'`);
    expect(r.rows[0]).toMatchObject({ short_name: 'ООО «7707083893»', entity_type: 'LEGAL_ENTITY', legal_status: 'ACTIVE', source_type: 'OFFICIAL', registry_seen_at: '2026-10-10' });
  });

  it('ОГРН, уже занятый другим ИНН, не записывается — импорт не падает на уникальном индексе', async () => {
    const ids = await runner.run('test', (client) => suppliers.upsert(client, [row('5031000000', '1027700132195')]));
    expect(ids.size).toBe(1);
    const r = await db.query(`SELECT ogrn FROM suppliers WHERE inn = '5031000000'`);
    expect(r.rows[0].ogrn).toBeNull();
  });

  it('ручная тестовая база не перезаписывается импортом', async () => {
    await db.query(`INSERT INTO suppliers (inn, ogrn, name, entity_type, legal_status, region_code, region_name, source_type, is_manual_test_data, checked_at)
                    VALUES ('0012345678', '1120012345678', 'Тестовая', 'LEGAL_ENTITY', 'ACTIVE', '00', 'Тест', 'MANUAL_TEST_DATA', true, now())`);
    const ids = await runner.run('test', (client) => suppliers.upsert(client, [row('0012345678', null)]));
    expect(ids.size).toBe(0);
    expect((await db.query(`SELECT name FROM suppliers WHERE inn = '0012345678'`)).rows[0].name).toBe('Тестовая');
  });

  it('замена сведений набора касается только своей части базы', async () => {
    const id = async (inn: string) => (await db.query(`SELECT id FROM suppliers WHERE inn = $1`, [inn])).rows[0].id as string;
    const [ul, ip] = [await id('7707083893'), await id('500100732259')];
    await runner.run('test', (client) => facts.replaceField(client, { field: 'tax_regime', source: 'FNS_PB', scope: 'IP' }, [fact(ip, 'tax_regime', 'ПСН', 'FNS_PB')]));
    await runner.run('test', (client) => facts.replaceField(client, { field: 'tax_regime', source: 'FNS_PB', scope: 'LEGAL_ENTITY' }, [fact(ul, 'tax_regime', 'ОСН', 'FNS_PB')]));
    await runner.run('test', (client) => facts.replaceField(client, { field: 'tax_regime', source: 'FNS_PB', scope: 'LEGAL_ENTITY' }, [fact(ul, 'tax_regime', 'УСН', 'FNS_PB')]));
    const r = await db.query(`SELECT s.inn, v.value FROM verification_records v JOIN suppliers s ON s.id = v.supplier_id WHERE v.field = 'tax_regime' ORDER BY s.inn`);
    expect(r.rows).toEqual([{ inn: '500100732259', value: 'ПСН' }, { inn: '7707083893', value: 'УСН' }]);
  });

  it('поставщики, которых нет в новой версии реестра, теряют подтверждённый статус', async () => {
    const n = await runner.run('test', (client) => suppliers.markNotSeen(client, '2026-11-10', null));
    expect(n).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM suppliers WHERE source_type = 'OFFICIAL' AND legal_status = 'UNKNOWN'`)).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM suppliers WHERE source_type = 'MANUAL_TEST_DATA' AND legal_status = 'ACTIVE'`)).toBe(1);
  });
});
