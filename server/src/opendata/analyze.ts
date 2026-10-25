import fs from 'node:fs';
import path from 'node:path';
import type { Catalog } from '../catalog/catalog';
import type { Logger } from '../logger';
import { readLatest } from './cache';
import { parseRsmpDoc, supplierType } from './importer';
import { forEachZipEntry, streamElements, tagAttrs } from './xmlStream';

export interface CategoryAnalysis {
  companies: number;
  products: number;
}

export interface RsmpAnalysis {
  dataset: 'rsmp';
  dataDate: string;
  file: string;
  files: number;
  documents: number;
  matchedDocuments: number;
  uniqueCompanies: number;
  duplicateDocuments: number;
  declaredCompanies: number;
  manufacturerCompanies: number;
  categories: Record<string, CategoryAnalysis>;
  regions: Record<string, number>;
  supplierTypes: Record<string, number>;
  skipped: Record<string, number>;
  elapsedSec: number;
}

interface MutableAnalysis extends Omit<RsmpAnalysis, 'categories' | 'uniqueCompanies' | 'elapsedSec'> {
  companies: Set<string>;
  categoryCompanies: Map<string, Set<string>>;
  categoryProducts: Map<string, number>;
}

const SKIP = {
  noInn: 'нет ИНН',
  noRegion: 'нет региона',
  noCategory: 'нет совпадения по категории',
  invalid: 'некорректная запись',
} as const;

/** Причина, по которой документ не стал поставщиком. Нужна для диагностики, а не для пользователя. */
function skipReason(doc: string, catalog: Catalog): string {
  if (!/ИНН(?:ЮЛ|ФЛ)="\d{10,12}"/.test(doc)) return SKIP.noInn;
  if (!tagAttrs(doc, 'СведМН')?.КодРегион) return SKIP.noRegion;
  if (!doc.includes('<СвПрод')) {
    const main = tagAttrs(doc, 'СвОКВЭДОсн');
    if (!main?.КодОКВЭД) return SKIP.noCategory;
    // Причина именно в правилах каталога: код есть, но ни одна категория не подошла.
    if (!parseRsmpDoc(doc, catalog, null)) return SKIP.noCategory;
  }
  return SKIP.invalid;
}

/**
 * Диагностический проход по реестру МСП без записи в БД.
 * Нужен, чтобы до тяжёлого импорта понять фактическое число компаний и категорий.
 */
export class RsmpAnalyzer {
  constructor(
    private readonly catalog: Catalog,
    private readonly log: Logger,
  ) {}

  async analyze(file: string, dataDate: string, regions: Set<string> | null, progressEvery = 250_000): Promise<RsmpAnalysis> {
    const stats: MutableAnalysis = {
      dataset: 'rsmp',
      dataDate,
      file,
      files: 0,
      documents: 0,
      matchedDocuments: 0,
      companies: new Set<string>(),
      duplicateDocuments: 0,
      declaredCompanies: 0,
      manufacturerCompanies: 0,
      categoryCompanies: new Map<string, Set<string>>(),
      categoryProducts: new Map<string, number>(),
      regions: {},
      supplierTypes: {},
      skipped: {},
    };
    const started = Date.now();

    await forEachZipEntry(file, async (_name, stream) => {
      stats.files += 1;
      await streamElements(stream, 'Документ', (doc) => {
        stats.documents += 1;
        if (progressEvery > 0 && stats.documents % progressEvery === 0) {
          this.log.info(
            { documents: stats.documents, matched: stats.matchedDocuments, companies: stats.companies.size, sec: Math.round((Date.now() - started) / 1000) },
            'rsmp analysis progress',
          );
        }

        const c = parseRsmpDoc(doc, this.catalog, regions);
        if (!c) {
          const reason = skipReason(doc, this.catalog);
          stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
          return;
        }

        stats.matchedDocuments += 1;
        if (stats.companies.has(c.inn)) {
          stats.duplicateDocuments += 1;
          return;
        }
        stats.companies.add(c.inn);
        if (c.declared.length) stats.declaredCompanies += 1;

        const type = supplierType(c).type;
        stats.supplierTypes[type] = (stats.supplierTypes[type] ?? 0) + 1;
        if (type === 'MANUFACTURER') stats.manufacturerCompanies += 1;
        if (c.regionCode) stats.regions[c.regionCode] = (stats.regions[c.regionCode] ?? 0) + 1;

        for (const categoryId of new Set(c.categories)) {
          const set = stats.categoryCompanies.get(categoryId) ?? new Set<string>();
          set.add(c.inn);
          stats.categoryCompanies.set(categoryId, set);
        }
        for (const product of c.products) {
          stats.categoryProducts.set(product.categoryId, (stats.categoryProducts.get(product.categoryId) ?? 0) + 1);
        }
      });
    });

    const categories: Record<string, CategoryAnalysis> = {};
    for (const [id, companies] of [...stats.categoryCompanies.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      categories[id] = { companies: companies.size, products: stats.categoryProducts.get(id) ?? 0 };
    }

    return {
      dataset: 'rsmp',
      dataDate,
      file,
      files: stats.files,
      documents: stats.documents,
      matchedDocuments: stats.matchedDocuments,
      uniqueCompanies: stats.companies.size,
      duplicateDocuments: stats.duplicateDocuments,
      declaredCompanies: stats.declaredCompanies,
      manufacturerCompanies: stats.manufacturerCompanies,
      categories,
      regions: stats.regions,
      supplierTypes: stats.supplierTypes,
      skipped: stats.skipped,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    };
  }
}

/** Сохраняет машинный JSON и человекочитаемый отчёт рядом с ним. */
export function saveAnalysis(dir: string, analysis: RsmpAnalysis): { json: string; markdown: string } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const json = path.join(dir, `rsmp-analysis-${stamp}.json`);
  const markdown = path.join(dir, `rsmp-analysis-${stamp}.md`);
  fs.writeFileSync(json, JSON.stringify(analysis, null, 2));
  fs.writeFileSync(markdown, renderAnalysis(analysis));
  return { json, markdown };
}

export function renderAnalysis(a: RsmpAnalysis): string {
  const lines: string[] = [
    '# Анализ реестра МСП',
    '',
    `- Дата набора: ${a.dataDate}`,
    `- Файл: \`${path.basename(a.file)}\``,
    `- Файлов в архиве: ${a.files}`,
    `- Документов: ${a.documents.toLocaleString('ru-RU')}`,
    `- Совпало документов: ${a.matchedDocuments.toLocaleString('ru-RU')}`,
    `- Уникальных компаний: **${a.uniqueCompanies.toLocaleString('ru-RU')}**`,
    `- Повторных документов: ${a.duplicateDocuments.toLocaleString('ru-RU')}`,
    `- С заявленной продукцией: ${a.declaredCompanies.toLocaleString('ru-RU')}`,
    `- Производителей: ${a.manufacturerCompanies.toLocaleString('ru-RU')}`,
    `- Время: ${a.elapsedSec} с`,
    '',
    '## Категории',
    '',
    '| Категория | Компаний | Записей о продукции |',
    '|---|---:|---:|',
    ...Object.entries(a.categories).map(([id, c]) => `| ${id} | ${c.companies.toLocaleString('ru-RU')} | ${c.products.toLocaleString('ru-RU')} |`),
    '',
    '## Типы поставщиков',
    '',
    ...Object.entries(a.supplierTypes).map(([type, n]) => `- ${type}: ${n.toLocaleString('ru-RU')}`),
    '',
    '## Пропущенные документы',
    '',
    ...Object.entries(a.skipped).map(([reason, n]) => `- ${reason}: ${n.toLocaleString('ru-RU')}`),
    '',
    '## Регионы',
    '',
    ...Object.entries(a.regions)
      .sort((x, y) => y[1] - x[1])
      .map(([code, n]) => `- ${code}: ${n.toLocaleString('ru-RU')}`),
    '',
  ];
  return lines.join('\n');
}

/** Читает последнюю версию реестра МСП из кэша. */
export function latestRsmp(dir: string): { file: string; dataDate: string } {
  const meta = readLatest(dir, 'rsmp');
  if (!meta) throw new Error('Архив реестра МСП не скачан: запустите `opendata download rsmp`');
  return { file: meta.file, dataDate: meta.dataDate };
}
