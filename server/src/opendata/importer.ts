import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { Catalog } from '../catalog/catalog';
import { loadConfig } from '../config';
import type { Db } from '../infra/db';
import type { Logger } from '../logger';
import { refreshProfileFlags } from '../search/repository';
import { categoriesForOkved, okvedMayMatch, prettyName, productsForOkpd2, titleCase } from './classify';
import { matchProduct } from '../parser/queryParser';
import { streamCsv } from './csvStream';
import { type LatestFile, readLatest } from './cache';
import { FAS_RNP, FNS_DATASETS } from './datasets';
import { downloadFile, latestFromPassport } from './download';
import { docRank, FSA_DATASETS, type FsaColumns, type FsaDocument, type FsaKind, fsaColumns, fsaRow } from './fsa';
import { list7z, stream7zEntry } from './sevenZip';
import { allTagAttrs, forEachZipEntry, streamElements, tagAttrs } from './xmlStream';
import { type FactWriteRow, type ProductWriteRow, SupplierBatchWriter, type SupplierWriteRow } from './writer';

const SME_CATEGORY: Record<string, string> = { '1': 'MICRO', '2': 'SMALL', '3': 'MEDIUM' };

interface Company {
  inn: string;
  ogrn: string | null;
  name: string;
  fullName: string;
  entityType: 'LEGAL_ENTITY' | 'IP';
  sme: string;
  includedAt: string | null;
  employees: number | null;
  regionCode: string;
  regionName: string;
  city: string | null;
  okvedMain: { code: string; name: string };
  okvedAdd: { code: string; name: string }[];
  declared: { code: string; name: string }[];
  categories: string[];
  products: { productId: string; categoryId: string; title: string; code: string }[];
}

/** DD.MM.YYYY → YYYY-MM-DD */
function isoDate(d: string | undefined): string | null {
  const m = d ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function regionName(catalog: Catalog, code: string, reg: Record<string, string> | null): string {
  const fromCatalog = catalog.region(code)?.name;
  if (fromCatalog) return fromCatalog;
  if (!reg?.Наим) return `Регион ${code}`;
  const type = (reg.Тип ?? '').toLowerCase();
  const n = reg.Наим;
  if (type.startsWith('г')) return n;
  if (type.startsWith('респ')) return n.toLowerCase().includes('республика') ? n : `Республика ${n}`;
  if (type.startsWith('обл')) return `${n} область`;
  if (type.startsWith('край')) return `${n} край`;
  if (type.includes('аобл') || type.includes('автономная')) return `${n} автономная область`;
  if (type.includes('ао') || type.includes('округ')) return `${n} автономный округ`;
  return `${n} ${reg.Тип ?? ''}`.trim();
}

/** Разбор документа реестра МСП. Возвращает null, если компания не относится к товарной вертикали. */
export function parseRsmpDoc(doc: string, catalog: Catalog, regions: Set<string> | null): Company | null {
  const main = tagAttrs(doc, 'СвОКВЭДОсн');
  const hasDeclared = doc.includes('<СвПрод');
  if (!hasDeclared && (!main?.КодОКВЭД || !okvedMayMatch(main.КодОКВЭД, catalog))) return null;

  const mn = tagAttrs(doc, 'СведМН');
  const regionCode = mn?.КодРегион ?? '';
  if (regions && !regions.has(regionCode)) return null;

  const declared = allTagAttrs(doc, 'СвПрод').map((p) => ({ code: p.КодПрод ?? '', name: p.НаимПрод ?? '' }));
  const categories = new Set(categoriesForOkved(main?.КодОКВЭД, main?.НаимОКВЭД, catalog));
  const products: Company['products'] = [];
  for (const d of declared) {
    for (const m of productsForOkpd2(d.code, catalog)) {
      products.push({ ...m, title: d.name || catalog.product(m.productId)!.name, code: d.code });
      categories.add(m.categoryId);
    }
  }
  if (!categories.size) return null;

  const head = tagAttrs(doc, 'Документ') ?? {};
  const org = tagAttrs(doc, 'ОргВклМСП');
  const ip = tagAttrs(doc, 'ИПВклМСП');
  let inn: string;
  let ogrn: string | null;
  let name: string;
  let fullName: string;
  if (org) {
    inn = org.ИННЮЛ;
    ogrn = org.ОГРН ?? null;
    name = prettyName(org.НаимОргСокр, org.НаимОрг);
    fullName = prettyName(org.НаимОрг, org.НаимОрг);
  } else if (ip) {
    const fio = tagAttrs(doc, 'ФИОИП') ?? {};
    inn = ip.ИННФЛ;
    ogrn = ip.ОГРНИП ?? null;
    const person = [fio.Фамилия, fio.Имя, fio.Отчество].filter(Boolean).map((x) => titleCase(x)).join(' ');
    name = `ИП ${person}`;
    fullName = `Индивидуальный предприниматель ${person}`;
  } else return null;
  if (!inn) return null;

  const city = tagAttrs(doc, 'Город') ?? tagAttrs(doc, 'НаселПункт');
  const ssr = head.ССЧР ?? tagAttrs(doc, 'СведССЧР')?.ССЧР;
  return {
    inn,
    ogrn,
    name,
    fullName,
    entityType: org ? 'LEGAL_ENTITY' : 'IP',
    sme: SME_CATEGORY[head.КатСубМСП] ?? 'UNKNOWN',
    includedAt: isoDate(head.ДатаВклМСП),
    employees: ssr ? Number(ssr) : null,
    regionCode,
    regionName: regionName(catalog, regionCode, tagAttrs(doc, 'Регион')),
    city: city?.Наим ? titleCase(city.Наим) : null,
    okvedMain: { code: main?.КодОКВЭД ?? '', name: main?.НаимОКВЭД ?? '' },
    okvedAdd: allTagAttrs(doc, 'СвОКВЭДДоп').map((o) => ({ code: o.КодОКВЭД, name: o.НаимОКВЭД })),
    declared,
    categories: [...categories],
    products,
  };
}

export function supplierType(c: Company): { type: string; confidence: number; basis: string } {
  if (c.products.length) {
    const names = [...new Set(c.products.map((p) => `«${p.title}» (ОКПД2 ${p.code})`))].slice(0, 3).join(', ');
    return {
      type: 'MANUFACTURER',
      confidence: 0.65,
      basis: `в реестре МСП компания указала производимую продукцию: ${names}. Сведения заявлены самой компанией`,
    };
  }
  return {
    type: 'UNKNOWN',
    confidence: 0.2,
    basis: `основной ОКВЭД ${c.okvedMain.code} «${c.okvedMain.name}». Одного ОКВЭД недостаточно, чтобы подтвердить производство`,
  };
}

/** Мульти-вставка строк одной таблицы одним запросом. */
async function insertRows(client: PoolClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const chunk = Math.max(1, Math.floor(60000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values: unknown[] = [];
    const tuples = part.map((r, j) => {
      values.push(...r);
      return `(${columns.map((_, k) => `$${j * columns.length + k + 1}`).join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

async function flushCompanies(writer: SupplierBatchWriter, batch: Company[], dataDate: string, sourceUrl: string, catalog: Catalog): Promise<void> {
  if (!batch.length) return;
  const checkedAt = `${dataDate}T00:00:00Z`;
  const fresh = new Date(`${dataDate}T00:00:00Z`);
  fresh.setUTCDate(fresh.getUTCDate() + 35);
  const freshUntil = fresh.toISOString();

  const suppliers: SupplierWriteRow[] = [];
  const products: ProductWriteRow[] = [];
  const facts: FactWriteRow[] = [];

  for (const c of batch) {
    const t = supplierType(c);
    const address = [c.regionName, c.city && c.city !== c.regionName ? `г. ${c.city}` : null].filter(Boolean).join(', ');
    suppliers.push({
      inn: c.inn,
      ogrn: c.ogrn,
      name: c.name,
      shortName: c.name,
      entityType: c.entityType,
      regionCode: c.regionCode,
      regionName: c.regionName,
      city: c.city,
      address,
      okvedMain: c.okvedMain,
      okvedAdditional: c.okvedAdd,
      smeStatus: c.sme,
      supplierType: t.type,
      supplierTypeConfidence: t.confidence,
      supplierTypeBasis: t.basis,
      checkedAt,
      registrySeenAt: dataDate,
      declaredProducts: c.declared,
    });

    const withProducts = new Set(c.products.map((p) => p.categoryId));
    for (const p of c.products) {
      products.push({
        inn: c.inn,
        categoryId: p.categoryId,
        productId: p.productId,
        title: p.title,
        okpd2: catalog.product(p.productId)?.okpd2 ?? null,
        origin: 'SME_DECLARED',
        source: 'SME_REGISTRY',
        sourceUrl,
        checkedAt,
      });
    }
    for (const cat of c.categories.filter((x) => !withProducts.has(x))) {
      products.push({
        inn: c.inn,
        categoryId: cat,
        productId: null,
        title: `Основной вид деятельности: ${c.okvedMain.name}`,
        okpd2: null,
        origin: 'OKVED',
        source: 'SME_REGISTRY',
        sourceUrl,
        checkedAt,
      });
    }

    const v = (field: string, value: string, confidence: number, notes: string | null = null) =>
      facts.push({
        inn: c.inn,
        field,
        value,
        source: 'SME_REGISTRY',
        sourceUrl,
        sourceType: 'OFFICIAL',
        checkedAt,
        freshUntil,
        confidence,
        isOfficial: true,
        isManual: false,
        notes,
      });
    v('legal_status', 'ACTIVE', 0.85, `Компания включена в реестр МСП на ${dataDate.split('-').reverse().join('.')}: в реестре только действующие субъекты. Статус в ЕГРЮЛ не проверялся`);
    v('okved_main', c.okvedMain.code, 0.99);
    v('okved_additional', c.okvedAdd.map((o) => o.code).join(','), 0.99);
    v('region', c.regionCode, 0.99);
    v('sme_status', c.sme, 0.99);
    if (c.includedAt) v('sme_included_at', c.includedAt, 0.99);
    if (c.employees !== null) v('employees_count', String(c.employees), 0.95, 'Среднесписочная численность по данным реестра МСП');
    if (c.declared.length) v('declared_products', c.declared.map((d) => `${d.code} ${d.name}`).join('; '), 0.6, 'Продукция заявлена самой компанией');
    v('supplier_type', t.type, t.confidence, t.basis);
  }

  await writer.write(suppliers, products, facts);
}

async function recordImport(db: Db, id: string, source: string, title: string, meta: LatestFile, total: number, matched: number, details: object = {}) {
  await db.query(
    `INSERT INTO opendata_imports (dataset, source, title, data_date, file_url, imported_at, rows_total, rows_matched, details)
     VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8)
     ON CONFLICT (dataset) DO UPDATE SET source = EXCLUDED.source, title = EXCLUDED.title, data_date = EXCLUDED.data_date, file_url = EXCLUDED.file_url,
       imported_at = now(), rows_total = EXCLUDED.rows_total, rows_matched = EXCLUDED.rows_matched, details = EXCLUDED.details`,
    [id, source, title, meta.dataDate, meta.url, total, matched, JSON.stringify(details)],
  );
}

/** Реестр МСП → реальные поставщики товарной вертикали. */
async function importRsmp(db: Db, dir: string, log: Logger, catalog: Catalog, regions: Set<string> | null): Promise<void> {
  const meta = readLatest(dir, 'rsmp');
  if (!meta) throw new Error('Архив реестра МСП не скачан: запустите `opendata download rsmp`');
  const sourceUrl = FNS_DATASETS.find((d) => d.id === 'rsmp')!.passport;
  let total = 0;
  let matched = 0;
  let files = 0;
  let batch: Company[] = [];
  const byCategory: Record<string, number> = {};
  const started = Date.now();
  log.info({ file: path.basename(meta.file), dataDate: meta.dataDate, regions: regions ? [...regions] : 'all' }, 'rsmp import started');

  await forEachZipEntry(meta.file, async (_name, stream) => {
    files += 1;
    await streamElements(stream, 'Документ', async (doc) => {
      total += 1;
      const c = parseRsmpDoc(doc, catalog, regions);
      if (!c) return;
      matched += 1;
      for (const cat of c.categories) byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      batch.push(c);
      if (batch.length >= 300) {
        const b = batch;
        batch = [];
        await flushCompanies(db, b, meta.dataDate, sourceUrl, catalog);
      }
    });
    if (files % 500 === 0) log.info({ files, total, matched, sec: Math.round((Date.now() - started) / 1000) }, 'rsmp import progress');
  });
  await flushCompanies(db, batch, meta.dataDate, sourceUrl, catalog);

  // Исключённые из реестра: статус больше не подтверждается
  const { rowCount } = await db.query(
    `UPDATE suppliers SET legal_status = 'UNKNOWN', updated_at = now()
      WHERE source_type = 'OFFICIAL' AND (registry_seen_at IS NULL OR registry_seen_at < $1) AND legal_status <> 'UNKNOWN'`,
    [meta.dataDate],
  );
  await recordImport(db, 'rsmp', 'SME_REGISTRY', 'Единый реестр субъектов МСП', meta, total, matched, { byCategory, excluded: rowCount, files });
  log.info({ total, matched, byCategory, excludedFromRegistry: rowCount, sec: Math.round((Date.now() - started) / 1000) }, 'rsmp import finished');
}

async function officialInns(db: Db): Promise<Map<string, string>> {
  const { rows } = await db.query<{ inn: string; id: string }>(`SELECT inn, id FROM suppliers WHERE source_type = 'OFFICIAL'`);
  return new Map(rows.map((r) => [r.inn, r.id]));
}

const rub = (n: number, digits = 0) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ₽`;

/** Год, на который составлены сведения (атрибут ДатаСост документа). */
const stateYear = (doc: string) => (tagAttrs(doc, 'Документ')?.ДатаСост ?? '').slice(-4);

/** Коды спецрежимов в наборе ФНС по ИП (7707329152-snrip). */
const IP_REGIMES: Record<string, string> = { '1': 'УСН', '2': 'АУСН', '3': 'ЕСХН', '4': 'ПСН', '5': 'НПД' };

/** Короткие названия налогов для строки «крупнейшие платежи». */
export function shortTaxName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('добавленную стоимость')) return 'НДС';
  if (n.includes('налог на прибыль')) return 'налог на прибыль';
  if (n.includes('упрощенн')) return 'УСН';
  if (n.includes('сельскохозяйствен')) return 'ЕСХН';
  if (n.includes('пенсионн')) return 'пенсионные взносы';
  if (n.includes('медицинск')) return 'медицинские взносы';
  if (n.includes('временной нетрудоспособности')) return 'взносы на соцстрахование';
  if (n.includes('несчастных случаев')) return 'взносы от несчастных случаев';
  if (n.includes('страховые взносы')) return 'страховые взносы';
  if (n.includes('пеней') || n.includes('пени')) return 'пени';
  if (n.includes('имущество')) return 'налог на имущество';
  if (n.includes('транспорт')) return 'транспортный налог';
  if (n.includes('земельн')) return 'земельный налог';
  if (n.includes('неналоговые')) return 'неналоговые доходы';
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Значение для verification_records; date и url — если отличаются от версии основного набора. */
type Fact = { value: string; notes: string | null; date?: string; url?: string };

/** Уплаченные налоги за год: итог и крупнейшие платежи (набор 7707329152-paytax). */
export function parsePaytax(doc: string): Fact {
  const items = allTagAttrs(doc, 'СвУплСумНал').map((a) => ({ name: shortTaxName(a.НаимНалог ?? ''), sum: Number(a.СумУплНал ?? 0) }));
  const total = items.reduce((s, i) => s + i.sum, 0);
  const year = stateYear(doc);
  const top = items
    .filter((i) => i.sum > 0)
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 3)
    .map((i) => `${i.name} — ${rub(i.sum)}`)
    .join('; ');
  return {
    value: total > 0 ? `${rub(total)} за ${year} год` : `Уплат нет за ${year} год`,
    notes: top ? `Крупнейшие платежи: ${top}` : 'Налоги, сборы и страховые взносы по данным ФНС',
  };
}

const ORG_FORMS: [RegExp, string][] = [
  [/^АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'АО '],
  [/^ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО\s*/i, 'ПАО '],
  [/^ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ\s*/i, 'ООО '],
  [/^АВТОНОМНАЯ НЕКОММЕРЧЕСКАЯ ОРГАНИЗАЦИЯ\s*/i, 'АНО '],
  [/^НЕКОММЕРЧЕСКАЯ ОРГАНИЗАЦИЯ\s*/i, 'НКО '],
  [/^ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ\s*/i, 'ГБУ '],
  [/^ГОСУДАРСТВЕННОЕ АВТОНОМНОЕ УЧРЕЖДЕНИЕ\s*/i, 'ГАУ '],
];

/** «АКЦИОНЕРНОЕ ОБЩЕСТВО «МСП БАНК»» → «АО «МСП БАНК»». */
export function shortOrgForm(name: string): string {
  for (const [re, short] of ORG_FORMS) if (re.test(name)) return name.replace(re, short);
  return name;
}

export interface SupportSummary {
  count: number;
  rub: number;
  violation: boolean;
  last: { date: string; form: string; kind: string; provider: string; amount: number | null } | null;
}

/** Меры поддержки из реестра МСП — получателей поддержки (7707329152-rsmppp). */
export function parseSupport(doc: string, into: SupportSummary = { count: 0, rub: 0, violation: false, last: null }): SupportSummary {
  for (const seg of doc.split('<СвПредПод').slice(1)) {
    const part = `<СвПредПод${seg}`;
    const a = tagAttrs(part, 'СвПредПод') ?? {};
    const size = tagAttrs(part, 'РазмПод');
    const amount = size?.ЕдПод === '1' ? Number(size.РазмПод ?? 0) : null;
    const date = isoDate(a.ДатаПрин) ?? isoDate(a.ДатаСвед) ?? '';
    into.count += 1;
    if (amount) into.rub += amount;
    if (a.ИнфНаруш === '1') into.violation = true;
    if (!into.last || date > into.last.date) {
      into.last = {
        date,
        form: tagAttrs(part, 'ФормПод')?.НаимФорм ?? '',
        kind: tagAttrs(part, 'ВидПод')?.НаимВид ?? '',
        provider: shortOrgForm(prettyName(a.НаимОрг, a.НаимОрг)),
        amount,
      };
    }
  }
  return into;
}

export function supportFact(s: SupportSummary): Fact {
  const measures = s.count % 10 === 1 && s.count % 100 !== 11 ? 'мера' : [2, 3, 4].includes(s.count % 10) && ![12, 13, 14].includes(s.count % 100) ? 'меры' : 'мер';
  const parts = [`${s.count} ${measures} поддержки`];
  if (s.rub > 0) parts.push(`${rub(s.rub)} в денежном выражении`);
  if (s.violation) parts.push('есть сведения о нарушении порядка и условий поддержки');
  const l = s.last;
  const last = l ? `Последняя — ${[l.form.toLowerCase(), l.kind.toLowerCase()].filter(Boolean).join(': ')}, ${l.date.split('-').reverse().join('.')}, ${l.provider}${l.amount ? `, ${rub(l.amount)}` : ''}` : null;
  return { value: parts.join('; '), notes: last };
}

/** Наборы «Прозрачного бизнеса» ФНС: численность, спецрежимы, задолженность, доходы/расходы, налоги, штрафы, поддержка МСП. */
async function importEnrichment(db: Db, dir: string, log: Logger): Promise<void> {
  const inns = await officialInns(db);
  if (!inns.size) {
    log.warn('no official suppliers yet — import rsmp first');
    return;
  }

  // ИНН получателя: у налоговых наборов — первый ИННЮЛ/ИННФЛ документа; в реестре поддержки ИННЮЛ есть и у органа поддержки
  const firstInn = (doc: string) => /ИНН(?:ЮЛ|ФЛ)="(\d+)"/.exec(doc)?.[1];
  const collect = async (id: string, onDoc: (doc: string, inn: string, supplierId: string) => void, innOf: (doc: string) => string | undefined = firstInn) => {
    const meta = readLatest(dir, id);
    if (!meta) {
      log.warn({ dataset: id }, 'dataset not downloaded, skipped');
      return null;
    }
    let total = 0;
    let matched = 0;
    await forEachZipEntry(meta.file, async (_n, stream) => {
      await streamElements(stream, 'Документ', (doc) => {
        total += 1;
        const inn = innOf(doc);
        const sid = inn ? inns.get(inn) : undefined;
        if (!inn || !sid) return;
        matched += 1;
        onDoc(doc, inn, sid);
      });
    });
    return { meta, total, matched };
  };

  // freshDays: ежемесячные наборы — 120 дней, годовые (уплаченные налоги, правонарушения) — до выхода следующей версии
  const writeVerifications = async (field: string, dataDate: string, sourceUrl: string, values: Map<string, Fact>, source = 'FNS_PB', freshDays = 120) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM verification_records WHERE field = $1 AND source = $2 AND is_manual_test_data = false`, [field, source]);
      const rows = [...values.entries()].map(([sid, v]) => {
        const checkedAt = `${v.date ?? dataDate}T00:00:00Z`;
        const fresh = new Date(checkedAt);
        fresh.setUTCDate(fresh.getUTCDate() + freshDays);
        return [sid, field, v.value, source, v.url ?? sourceUrl, 'OFFICIAL', checkedAt, fresh.toISOString(), 0.95, true, false, v.notes];
      });
      await insertRows(client, 'verification_records', ['supplier_id', 'field', 'value', 'source', 'source_url', 'source_type', 'checked_at', 'fresh_until', 'confidence', 'is_official', 'is_manual_test_data', 'notes'], rows);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  // Численность
  const employees = new Map<string, { value: string; notes: string | null }>();
  const sshr = await collect('sshr', (doc, _inn, sid) => {
    const n = tagAttrs(doc, 'СведССЧР')?.КолРаб;
    const d = tagAttrs(doc, 'Документ')?.ДатаСост;
    if (n) employees.set(sid, { value: n, notes: `Среднесписочная численность на ${d ?? 'отчётную дату'}` });
  });
  if (sshr) {
    await writeVerifications('employees_count', sshr.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'sshr')!.passport, employees);
    await recordImport(db, 'sshr', 'FNS_PB', 'Среднесписочная численность работников', sshr.meta, sshr.total, sshr.matched);
    log.info({ matched: sshr.matched }, 'sshr imported');
  }

  // Специальные налоговые режимы: юрлица (snr) и ИП (snrip); в наборах только те, кто применяет спецрежим
  const regimes = new Map<string, Fact>();
  const snr = await collect('snr', (doc, _inn, sid) => {
    const a = tagAttrs(doc, 'СведСНР') ?? {};
    const list = [a.ПризнУСН === '1' && 'УСН', a.ПризнАУСН === '1' && 'АУСН', a.ПризнЕСХН === '1' && 'ЕСХН', a.ПризнСРП === '1' && 'СРП'].filter(Boolean);
    if (list.length) regimes.set(sid, { value: list.join(', '), notes: 'Специальный налоговый режим' });
  });
  if (snr) {
    for (const [inn, sid] of inns) if (inn.length === 10 && !regimes.has(sid)) regimes.set(sid, { value: 'ОСН (специальный режим не применяется)', notes: 'Компании нет в наборе спецрежимов ФНС' });
    await recordImport(db, 'snr', 'FNS_PB', 'Специальные налоговые режимы', snr.meta, snr.total, snr.matched);
    log.info({ matched: snr.matched }, 'snr imported');
  }
  const snripDate = readLatest(dir, 'snrip')?.dataDate;
  const snripUrl = FNS_DATASETS.find((d) => d.id === 'snrip')!.passport;
  const snrip = await collect('snrip', (doc, _inn, sid) => {
    const list = [...new Set(allTagAttrs(doc, 'СведСНР').map((a) => IP_REGIMES[a.ПризнСНР ?? '']).filter(Boolean))];
    if (list.length) regimes.set(sid, { value: list.join(', '), notes: 'Специальный налоговый режим индивидуального предпринимателя', date: snripDate, url: snripUrl });
  });
  if (snrip) {
    // ИП без записи в наборе может применять ОСН — значение по умолчанию не ставим
    await recordImport(db, 'snrip', 'FNS_PB', 'Специальные налоговые режимы ИП', snrip.meta, snrip.total, snrip.matched);
    log.info({ matched: snrip.matched }, 'snrip imported');
  }
  if (snr || snrip) await writeVerifications('tax_regime', (snr ?? snrip)!.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'snr')!.passport, regimes);

  // Задолженность: суммируем по всем налогам
  const debts = new Map<string, number>();
  const debtam = await collect('debtam', (doc, _inn, sid) => {
    const sum = allTagAttrs(doc, 'СведНедоим').reduce((acc, a) => acc + Number(a.ОбщСумНедоим ?? 0), 0);
    debts.set(sid, (debts.get(sid) ?? 0) + sum);
  });
  if (debtam) {
    const values = new Map<string, { value: string; notes: string | null }>();
    for (const [inn, sid] of inns) {
      if (inn.length !== 10) continue; // набор только по юрлицам
      const d = debts.get(sid);
      values.set(sid, d
        ? { value: `${d.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`, notes: 'Недоимка, пени и штрафы по данным ФНС' }
        : { value: 'Нет в наборе задолженностей', notes: 'Задолженность по данным ФНС не выявлена' });
    }
    await writeVerifications('tax_debt', debtam.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'debtam')!.passport, values);
    await recordImport(db, 'debtam', 'FNS_PB', 'Задолженность по налогам и сборам', debtam.meta, debtam.total, debtam.matched);
    log.info({ matched: debtam.matched }, 'debtam imported');
  }

  // Уплаченные налоги и взносы за прошлый год (только юрлица)
  const paid = new Map<string, Fact>();
  const paytax = await collect('paytax', (doc, _inn, sid) => paid.set(sid, parsePaytax(doc)));
  if (paytax) {
    await writeVerifications('taxes_paid', paytax.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'paytax')!.passport, paid, 'FNS_PB', 400);
    await recordImport(db, 'paytax', 'FNS_PB', 'Уплаченные налоги и сборы', paytax.meta, paytax.total, paytax.matched);
    log.info({ matched: paytax.matched }, 'paytax imported');
  }

  // Налоговые правонарушения: суммы штрафов (только юрлица)
  const fines = new Map<string, { sum: number; year: string }>();
  const taxoffence = await collect('taxoffence', (doc, _inn, sid) => {
    const sum = allTagAttrs(doc, 'СведНаруш').reduce((acc, a) => acc + Number(a.СумШтраф ?? 0), 0);
    fines.set(sid, { sum: (fines.get(sid)?.sum ?? 0) + sum, year: stateYear(doc) });
  });
  if (taxoffence) {
    const values = new Map<string, Fact>();
    for (const [inn, sid] of inns) {
      if (inn.length !== 10) continue;
      const f = fines.get(sid);
      values.set(sid, f
        ? { value: `Штрафы ${rub(f.sum, 2)} за ${f.year} год`, notes: 'Налоговые правонарушения и меры ответственности по данным ФНС' }
        : { value: 'Нет в наборе правонарушений', notes: 'Штрафов за налоговые правонарушения по данным ФНС нет' });
    }
    await writeVerifications('tax_offences', taxoffence.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'taxoffence')!.passport, values, 'FNS_PB', 400);
    await recordImport(db, 'taxoffence', 'FNS_PB', 'Налоговые правонарушения и меры ответственности', taxoffence.meta, taxoffence.total, taxoffence.matched);
    log.info({ matched: taxoffence.matched }, 'taxoffence imported');
  }

  // Реестр МСП — получателей поддержки: ИНН получателя в СвЮЛ или СвФЛ (ИННЮЛ внутри СвПредПод — это орган поддержки)
  const support = new Map<string, SupportSummary>();
  const rsmppp = await collect(
    'rsmppp',
    (doc, _inn, sid) => support.set(sid, parseSupport(doc, support.get(sid))),
    (doc) => tagAttrs(doc, 'СвЮЛ')?.ИННЮЛ ?? tagAttrs(doc, 'СвФЛ')?.ИННФЛ,
  );
  if (rsmppp) {
    const values = new Map([...support.entries()].map(([sid, s]) => [sid, supportFact(s)]));
    await writeVerifications('sme_support', rsmppp.meta.dataDate, FNS_DATASETS.find((d) => d.id === 'rsmppp')!.passport, values, 'SME_SUPPORT');
    await recordImport(db, 'rsmppp', 'SME_SUPPORT', 'Реестр МСП — получателей поддержки', rsmppp.meta, rsmppp.total, rsmppp.matched);
    log.info({ matched: rsmppp.matched, companies: support.size }, 'rsmppp imported');
  }

  // Доходы и расходы по бухгалтерской отчётности (в рублях)
  const fin = new Map<string, { year: number; revenue: number; expenses: number }>();
  const revexp = await collect('revexp', (doc, _inn, sid) => {
    const a = tagAttrs(doc, 'СведДохРасх') ?? {};
    const year = Number((tagAttrs(doc, 'Документ')?.ДатаСост ?? '').slice(-4)) || new Date().getUTCFullYear() - 1;
    fin.set(sid, { year, revenue: Math.round(Number(a.СумДоход ?? 0)), expenses: Math.round(Number(a.СумРасход ?? 0)) });
  });
  if (revexp) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM financial_reports WHERE source = 'FNS_REVEXP'`);
      const checkedAt = `${revexp.meta.dataDate}T00:00:00Z`;
      const url = FNS_DATASETS.find((d) => d.id === 'revexp')!.passport;
      const rows = [...fin.entries()].map(([sid, f]) => [sid, f.year, f.revenue, f.expenses, 'RUB', 'FNS_REVEXP', url, false, checkedAt]);
      await insertRows(client, 'financial_reports', ['supplier_id', 'period_year', 'revenue', 'expenses', 'unit', 'source', 'source_url', 'is_manual_test_data', 'checked_at'], rows);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await recordImport(db, 'revexp', 'FNS_REVEXP', 'Доходы и расходы по бухгалтерской отчётности', revexp.meta, revexp.total, revexp.matched);
    log.info({ matched: revexp.matched }, 'revexp imported');
  }

  log.info({ updated: await refreshProfileFlags(db) }, 'profile flags refreshed');
}

export async function importFns(db: Db, dir: string, log: Logger, opts: { regions: string; only?: string[] }): Promise<void> {
  const config = loadConfig();
  const catalog = Catalog.load(config.dataDir);
  const regions = opts.regions ? new Set(opts.regions.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  if (!opts.only || opts.only.includes('rsmp')) await importRsmp(db, dir, log, catalog, regions);
  await importEnrichment(db, dir, log);
}

/**
 * РНП ФАС (открытый набор 7703516539-rnp). Формат CSV; колонку ИНН определяем по заголовку.
 * С зарубежных IP сайт недоступен — запускайте на сервере в РФ или без VPN.
 */
export async function importFasRnp(db: Db, dir: string, log: Logger): Promise<void> {
  const latest = await latestFromPassport(FAS_RNP.passport);
  const file = path.join(dir, 'rnp', path.basename(new URL(latest.url).pathname));
  await downloadFile(latest.url, file, log);
  const raw = fs.readFileSync(file);
  const text = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || /[Ѐ-ӿ]/.test(raw.subarray(0, 2000).toString('utf8'))
    ? raw.toString('utf8')
    : new TextDecoder('windows-1251').decode(raw);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === sep && !q) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const innCol = col(/инн/);
  if (innCol < 0) throw new Error(`В наборе РНП не найдена колонка ИНН: ${header.join(' | ')}`);
  const numCol = col(/номер|реестров/);
  const dateCol = col(/дата.*(включ|внесен|публикац)/);
  const reasonCol = col(/основани|причин/);

  const inns = await officialInns(db);
  const rows: unknown[][] = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const inn = (cells[innCol] ?? '').replace(/\D/g, '');
    const sid = inns.get(inn);
    if (!sid) continue;
    const date = cells[dateCol] ? isoDate(cells[dateCol].slice(0, 10)) ?? cells[dateCol].slice(0, 10) : null;
    rows.push([sid, 'RNP', 'Запись в реестре недобросовестных поставщиков', reasonCol >= 0 ? cells[reasonCol] || null : null, numCol >= 0 ? cells[numCol] || null : null, date, 'FAS_RNP', FAS_RNP.passport, false, `${latest.dataDate}T00:00:00Z`]);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM risk_signals WHERE source = 'FAS_RNP' AND is_manual_test_data = false`);
    await insertRows(client, 'risk_signals', ['supplier_id', 'kind', 'title', 'details', 'record_number', 'published_at', 'source', 'source_url', 'is_manual_test_data', 'checked_at'], rows);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recordImport(db, 'rnp', 'FAS_RNP', FAS_RNP.title, { file, dataDate: latest.dataDate, url: latest.url }, lines.length - 1, rows.length);
  log.info({ records: lines.length - 1, matched: rows.length }, 'FAS RNP imported');
}


/** Документов одного вида на компанию после объединения срезов: действующие и самые свежие. */
const FSA_DOCS_PER_SUPPLIER = 30;

interface FsaSource {
  archive: string;
  /** Файл внутри архива; null — сам файл является CSV. */
  entry: string | null;
  /** Начало периода среза (YYYYMMDD) — для порядка обработки. */
  period: string;
}

/** Первая дата в имени файла → YYYYMMDD. Встречаются оба формата: rss_20240601-20240630.csv и rss_01062025-30062025.csv. */
export function dateIn(name: string): string {
  for (const m of name.matchAll(/(?<!\d)(\d{8})(?!\d)/g)) {
    const s = m[1];
    if (/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)) return s;
    if (/^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])20\d{2}$/.test(s)) return `${s.slice(4)}${s.slice(2, 4)}${s.slice(0, 2)}`;
  }
  return '00000000';
}

/**
 * Файлы набора в папке: 7z/zip с помесячными CSV внутри или отдельные CSV. Росаккредитация публикует архивы
 * с перекрывающимися периодами — одинаковый месячный CSV берём из самого нового архива.
 */
async function fsaSources(folder: string): Promise<{ sources: FsaSource[]; archives: string[]; dataDate: string | null }> {
  const archives = fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((f) => /\.(7z|zip|csv)$/i.test(f)).sort((a, b) => dateIn(a).localeCompare(dateIn(b)))
    : [];
  const byEntry = new Map<string, FsaSource>();
  for (const name of archives) {
    const file = path.join(folder, name);
    let entries: (string | null)[] = [null];
    if (/\.7z$/i.test(name)) entries = (await list7z(file)).filter((e) => /\.csv$/i.test(e));
    else if (/\.zip$/i.test(name)) {
      entries = [];
      await forEachZipEntry(file, async (e, s) => {
        entries.push(e);
        s.resume();
      }, /\.csv$/i);
    }
    // Архивы отсортированы от старых к новым: более новый архив перезаписывает тот же месяц
    for (const e of entries) byEntry.set(e ? path.basename(e).toLowerCase() : name, { archive: file, entry: e, period: e ? dateIn(path.basename(e)) : dateIn(name) });
  }
  const last = archives.at(-1);
  const d = last ? dateIn(last) : null;
  return {
    sources: [...byEntry.values()].sort((a, b) => a.period.localeCompare(b.period)),
    archives,
    dataDate: d && d !== '00000000' ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
  };
}

/**
 * Открытые данные Росаккредитации (7736638268-rds — декларации, 7736638268-rss — сертификаты).
 * Объединяет все срезы из папки <OPENDATA_DIR>/fsa-<rds|rss>: более поздняя запись о документе заменяет раннюю.
 * Документ привязывается к поставщику по ИНН изготовителя или заявителя, товар — по кодам ОКПД2 и справочнику синонимов.
 * offline — не обращаться к fsa.gov.ru (архивы уже скачаны, например через браузер): с зарубежных IP сайт недоступен.
 */
export async function importFsa(db: Db, dir: string, log: Logger, kind: FsaKind, opts: { offline?: boolean } = {}): Promise<void> {
  const ds = FSA_DATASETS[kind];
  const catalog = Catalog.load(loadConfig().dataDir);
  const folder = path.join(dir, `fsa-${kind}`);
  if (!opts.offline) {
    const latest = await latestFromPassport(ds.passport);
    await downloadFile(latest.url, path.join(folder, path.basename(new URL(latest.url).pathname)), log);
  }
  const { sources, archives, dataDate } = await fsaSources(folder);
  if (!sources.length || !dataDate) throw new Error(`Нет архивов Росаккредитации в ${folder}`);
  log.info({ dataset: kind, archives: archives.length, files: sources.length, from: sources[0].period, to: sources.at(-1)!.period }, 'fsa import started');

  const inns = await officialInns(db);
  const bySupplier = new Map<string, Map<string, FsaDocument>>();
  const prune = (docs: Map<string, FsaDocument>) => {
    const keep = [...docs.values()].sort((a, b) => docRank(b).localeCompare(docRank(a))).slice(0, FSA_DOCS_PER_SUPPLIER * 2);
    docs.clear();
    for (const d of keep) docs.set(d.number, d);
  };
  let cols: FsaColumns | null = null;
  let total = 0;
  const skipped: string[] = [];
  const onRow = (cells: string[]) => {
    if (!cols) return;
    total += 1;
    const d = fsaRow(cells, cols);
    if (!d) return;
    for (const inn of new Set([d.manufacturerInn, d.applicantInn])) {
      const sid = inn ? inns.get(inn) : undefined;
      if (!sid) continue;
      const docs = bySupplier.get(sid) ?? new Map<string, FsaDocument>();
      docs.set(d.number, d);
      if (docs.size > FSA_DOCS_PER_SUPPLIER * 4) prune(docs);
      bySupplier.set(sid, docs);
    }
  };
  let current = '';
  // Файл с нераспознанной структурой пропускаем с предупреждением, чтобы один выбивающийся CSV не срывал импорт
  const onHeader = (h: string[]) => {
    try {
      cols = fsaColumns(h);
    } catch (err) {
      cols = null;
      skipped.push(current);
      log.warn({ dataset: kind, file: current, err: (err as Error).message.slice(0, 400) }, 'fsa file skipped');
    }
  };
  const started = Date.now();
  for (const src of sources) {
    const before = total;
    current = src.entry ?? path.basename(src.archive);
    if (src.entry && /\.7z$/i.test(src.archive)) await stream7zEntry(src.archive, src.entry, (s) => streamCsv(s, onHeader, onRow).then(() => undefined));
    else if (src.entry) await forEachZipEntry(src.archive, (e, s) => (e === src.entry ? streamCsv(s, onHeader, onRow).then(() => undefined) : Promise.resolve(void s.resume())), /\.csv$/i);
    else await streamCsv(fs.createReadStream(src.archive), onHeader, onRow);
    log.info({ dataset: kind, file: src.entry ?? path.basename(src.archive), rows: total - before, suppliers: bySupplier.size, sec: Math.round((Date.now() - started) / 1000) }, 'fsa file imported');
  }

  const checkedAt = `${dataDate}T00:00:00Z`;
  const rows: unknown[][] = [];
  for (const [sid, map] of bySupplier) {
    const docs = [...map.values()].sort((a, b) => docRank(b).localeCompare(docRank(a))).slice(0, FSA_DOCS_PER_SUPPLIER);
    for (const d of docs) {
      const byCode = d.okpd2.flatMap((c) => productsForOkpd2(c, catalog))[0];
      const byName = !byCode && d.product ? matchProduct(d.product, catalog)[0] : undefined;
      const productId = byCode?.productId ?? (byName && byName.confidence >= 0.6 ? byName.productId : null);
      rows.push([
        sid, productId, ds.type, d.number, d.status, d.manufacturerInn, d.manufacturerName, d.applicantName, d.product,
        d.techRegulation, d.body, d.validFrom, d.validTo, ds.source, ds.passport, false, checkedAt,
      ]);
    }
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM compliance_documents WHERE source = $1 AND is_manual_test_data = false`, [ds.source]);
    await insertRows(
      client,
      'compliance_documents',
      ['supplier_id', 'product_id', 'document_type', 'number', 'status', 'manufacturer_inn', 'manufacturer_name', 'applicant', 'product_name', 'tech_regulation', 'certification_body', 'valid_from', 'valid_to', 'source', 'source_url', 'is_manual_test_data', 'checked_at'],
      rows,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const newest = archives.at(-1)!;
  await recordImport(db, `fsa-${kind}`, ds.source, ds.title, { file: path.join(folder, newest), dataDate, url: `${ds.passport}${newest}` }, total, rows.length, {
    suppliers: bySupplier.size,
    files: sources.length,
    skipped,
    periodFrom: sources[0].period,
    periodTo: sources.at(-1)!.period,
  });
  log.info({ dataset: kind, records: total, documents: rows.length, suppliers: bySupplier.size, sec: Math.round((Date.now() - started) / 1000) }, 'FSA imported');
}
