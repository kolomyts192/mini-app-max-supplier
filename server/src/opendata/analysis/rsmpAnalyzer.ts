import path from 'node:path';
import type { Catalog } from '../../catalog/catalog';
import type { Logger } from '../../logger';
import type { Company } from '../domain/company';
import type { Report } from '../io/reportStore';
import { allTagAttrs, forEachZipEntry, streamElements, tagAttrs } from '../io/xmlStream';
import { CatalogClassifier } from '../parsing/classify';
import { RsmpParser, SupplierTypeAssessor } from '../parsing/rsmpParser';
import { CompanyValidator } from '../validation/companyValidator';
import { Quarantine } from '../validation/quarantine';

export interface CategoryAnalysis {
  name: string;
  companies: number;
  /** Из них — по основному ОКВЭД и по заявленной продукции (компания может попасть обоими путями). */
  byOkved: number;
  byDeclared: number;
  manufacturers: number;
  /** Компании, которые попали бы в категорию только по дополнительному ОКВЭД (сейчас не учитывается). */
  additionalOkvedOnly: number;
}

export interface RsmpAnalysis {
  dataset: 'rsmp';
  dataDate: string;
  file: string;
  files: number;
  documents: number;
  /** Все документы реестра с ИНН и кодом региона. */
  documentsWithInnAndRegion: number;
  /** Все документы реестра с заявленной продукцией (СвПрод). */
  documentsWithDeclared: number;
  /** Документы, отнесённые к категориям справочника. */
  matchedDocuments: number;
  /** Уникальные компании (по ИНН) с корректными реквизитами — прогноз числа поставщиков после импорта. */
  uniqueCompanies: number;
  duplicateInnDocuments: number;
  /** Компании с ОГРН, который уже встречался у другого ИНН. */
  duplicateOgrn: number;
  withOgrn: number;
  legalEntities: number;
  individuals: number;
  matchedByOkved: number;
  matchedByDeclared: number;
  matchedByBoth: number;
  /** Компании вне вертикали, которые попали бы в неё по дополнительным ОКВЭД. */
  additionalOkvedOnly: number;
  manufacturers: number;
  categories: Record<string, CategoryAnalysis>;
  regions: Record<string, number>;
  supplierTypes: Record<string, number>;
  skipped: Record<string, number>;
  quarantine: Record<string, number>;
  elapsedSec: number;
}

/**
 * Диагностический проход по реестру МСП без записи в БД: точное число компаний и покрытие категорий
 * до тяжёлого импорта. Использует те же парсер и валидатор, что и импорт.
 */
export class RsmpAnalyzer {
  private readonly parser: RsmpParser;
  private readonly classifier: CatalogClassifier;
  private readonly validator = new CompanyValidator();
  private readonly assessor = new SupplierTypeAssessor();

  constructor(
    private readonly catalog: Catalog,
    private readonly log: Logger,
    regions: ReadonlySet<string> | null = null,
  ) {
    this.parser = new RsmpParser(catalog, regions);
    this.classifier = CatalogClassifier.for(catalog);
  }

  async analyze(file: string, dataDate: string, progressEvery = 500_000): Promise<RsmpAnalysis> {
    const started = Date.now();
    const a = this.empty(file, dataDate);
    const seenInn = new Set<string>();
    const ogrnOwner = new Map<string, string>();
    const quarantine = new Quarantine('rsmp');

    await forEachZipEntry(file, async (_name, stream) => {
      a.files += 1;
      await streamElements(stream, 'Документ', (doc) => {
        a.documents += 1;
        if (progressEvery > 0 && a.documents % progressEvery === 0) {
          const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
          this.log.info({ documents: a.documents, matched: a.matchedDocuments, companies: seenInn.size, heapMb, sec: Math.round((Date.now() - started) / 1000) }, 'rsmp analysis progress');
        }
        if (/ИНН(?:ЮЛ|ФЛ)="\d+"/.test(doc) && /<СведМН[^>]*КодРегион="\d{2}"/.test(doc)) a.documentsWithInnAndRegion += 1;
        if (doc.includes('<СвПрод')) a.documentsWithDeclared += 1;

        const outcome = this.parser.parse(doc);
        if (!outcome.company) {
          a.skipped[outcome.skip] = (a.skipped[outcome.skip] ?? 0) + 1;
          if (outcome.skip === 'category') this.countAdditionalOkved(doc, a);
          return;
        }
        a.matchedDocuments += 1;
        const c = outcome.company;
        const issues = this.validator.validate(c);
        if (issues.length) {
          quarantine.add(issues.map((i) => i.reason).join('; '), c.inn, doc);
          return;
        }
        if (seenInn.has(c.inn)) {
          a.duplicateInnDocuments += 1;
          return;
        }
        seenInn.add(c.inn);
        if (c.ogrn) {
          const owner = ogrnOwner.get(c.ogrn);
          if (owner && owner !== c.inn) a.duplicateOgrn += 1;
          else ogrnOwner.set(c.ogrn, c.inn);
        }
        this.countCompany(c, a);
      });
    });

    a.uniqueCompanies = seenInn.size;
    a.quarantine = quarantine.reasons();
    a.elapsedSec = Math.round((Date.now() - started) / 1000);
    return a;
  }

  private countCompany(c: Company, a: RsmpAnalysis): void {
    if (c.ogrn) a.withOgrn += 1;
    if (c.entityType === 'IP') a.individuals += 1;
    else a.legalEntities += 1;
    const byOkved = c.matchedBy.okved.length > 0;
    const byDeclared = c.matchedBy.declared.length > 0;
    if (byOkved) a.matchedByOkved += 1;
    if (byDeclared) a.matchedByDeclared += 1;
    if (byOkved && byDeclared) a.matchedByBoth += 1;

    const type = this.assessor.assess(c).type;
    a.supplierTypes[type] = (a.supplierTypes[type] ?? 0) + 1;
    if (type === 'MANUFACTURER') a.manufacturers += 1;
    a.regions[c.regionCode] = (a.regions[c.regionCode] ?? 0) + 1;

    for (const id of c.categories) {
      const cat = this.category(a, id);
      cat.companies += 1;
      if (c.matchedBy.okved.includes(id)) cat.byOkved += 1;
      if (c.matchedBy.declared.includes(id)) cat.byDeclared += 1;
      if (type === 'MANUFACTURER' && c.products.some((p) => p.categoryId === id)) cat.manufacturers += 1;
    }
  }

  /** Сколько компаний добавили бы дополнительные ОКВЭД — чтобы решить, учитывать ли их в правилах. */
  private countAdditionalOkved(doc: string, a: RsmpAnalysis): void {
    if (!doc.includes('<СвОКВЭДДоп')) return;
    const region = tagAttrs(doc, 'СведМН')?.КодРегион;
    if (!region) return;
    const extra = new Set(allTagAttrs(doc, 'СвОКВЭДДоп').flatMap((o) => this.classifier.categoriesForOkved(o.КодОКВЭД, o.НаимОКВЭД)));
    if (!extra.size) return;
    a.additionalOkvedOnly += 1;
    for (const id of extra) this.category(a, id).additionalOkvedOnly += 1;
  }

  private category(a: RsmpAnalysis, id: string): CategoryAnalysis {
    a.categories[id] ??= { name: this.catalog.category(id)?.name ?? id, companies: 0, byOkved: 0, byDeclared: 0, manufacturers: 0, additionalOkvedOnly: 0 };
    return a.categories[id];
  }

  private empty(file: string, dataDate: string): RsmpAnalysis {
    const a: RsmpAnalysis = {
      dataset: 'rsmp', dataDate, file, files: 0, documents: 0, documentsWithInnAndRegion: 0, documentsWithDeclared: 0, matchedDocuments: 0,
      uniqueCompanies: 0, duplicateInnDocuments: 0, duplicateOgrn: 0, withOgrn: 0, legalEntities: 0, individuals: 0, matchedByOkved: 0,
      matchedByDeclared: 0, matchedByBoth: 0, additionalOkvedOnly: 0, manufacturers: 0, categories: {}, regions: {}, supplierTypes: {},
      skipped: {}, quarantine: {}, elapsedSec: 0,
    };
    // Все категории справочника, в том числе пустые: пустая категория — тоже результат диагностики
    for (const c of this.catalog.data.categories) this.category(a, c.id);
    return a;
  }
}

const n = (v: number) => v.toLocaleString('ru-RU');
const pct = (part: number, total: number) => (total ? `${((part / total) * 100).toFixed(1)}%` : '—');

/** Отчёт диагностики: JSON и Markdown. benchmark — эталон из README для сравнения. */
export function analysisReport(a: RsmpAnalysis, benchmark?: number): Report {
  const cats = Object.entries(a.categories).sort((x, y) => y[1].companies - x[1].companies);
  const lines = [
    '# Анализ реестра МСП',
    '',
    `- Дата набора: ${a.dataDate.split('-').reverse().join('.')}`,
    `- Файл: \`${path.basename(a.file)}\` (${a.files} XML-файлов), разбор за ${a.elapsedSec} с`,
    `- Документов в реестре: ${n(a.documents)}; с ИНН и регионом: ${n(a.documentsWithInnAndRegion)}; с заявленной продукцией: ${n(a.documentsWithDeclared)}`,
    `- Отнесено к категориям справочника: ${n(a.matchedDocuments)} документов`,
    `- **Уникальных компаний с корректными реквизитами: ${n(a.uniqueCompanies)}**${benchmark ? ` (эталон README — ${n(benchmark)}, ${pct(a.uniqueCompanies, benchmark)})` : ''}`,
    `- Юрлиц: ${n(a.legalEntities)}, ИП: ${n(a.individuals)}; с ОГРН: ${n(a.withOgrn)} (${pct(a.withOgrn, a.uniqueCompanies)})`,
    `- По основному ОКВЭД: ${n(a.matchedByOkved)}; по заявленной продукции: ${n(a.matchedByDeclared)}; обоими путями: ${n(a.matchedByBoth)}`,
    `- Производителей (заявили продукцию): ${n(a.manufacturers)}`,
    `- Повторных документов по ИНН: ${n(a.duplicateInnDocuments)}; ОГРН у другого ИНН: ${n(a.duplicateOgrn)}`,
    `- Вне вертикали, но подошли бы по дополнительному ОКВЭД: ${n(a.additionalOkvedOnly)} (сейчас не учитываются)`,
    '',
    '## Категории',
    '',
    '| Категория | Компаний | По ОКВЭД | По продукции | Производителей | +по доп. ОКВЭД |',
    '|---|---:|---:|---:|---:|---:|',
    ...cats.map(([id, c]) => `| ${c.name} (\`${id}\`) | ${n(c.companies)} | ${n(c.byOkved)} | ${n(c.byDeclared)} | ${n(c.manufacturers)} | ${n(c.additionalOkvedOnly)} |`),
    '',
    `Непустых категорий: ${cats.filter(([, c]) => c.companies > 0).length} из ${cats.length}; со 100+ компаниями: ${cats.filter(([, c]) => c.companies >= 100).length}.`,
    '',
    '## Карантин (реквизиты не прошли проверку)',
    '',
    ...(Object.keys(a.quarantine).length ? Object.entries(a.quarantine).map(([reason, v]) => `- ${reason}: ${n(v)}`) : ['- нет']),
    '',
    '## Отсеяно',
    '',
    ...Object.entries(a.skipped).map(([reason, v]) => `- ${reason === 'category' ? 'нет совпадения с категориями' : 'вне выбранных регионов'}: ${n(v)}`),
    '',
    `## Регионы (${Object.keys(a.regions).length})`,
    '',
    ...Object.entries(a.regions)
      .sort((x, y) => y[1] - x[1])
      .map(([code, v]) => `- ${code}: ${n(v)}`),
    '',
  ];
  return { json: a, markdown: lines.join('\n') };
}
