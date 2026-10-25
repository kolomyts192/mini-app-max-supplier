import crypto from 'node:crypto';
import type { Catalog } from '../catalog/catalog';
import { plural } from '../catalog/text';
import { CERTIFICATE_LABEL, type SearchQuery, SUPPLIER_PREF_LABEL } from '../domain/types';
import type { Db } from '../infra/db';
import { searches, searchLatency } from '../infra/metrics';
import { hashUserId, type Logger } from '../logger';
import { matchProduct } from '../parser/queryParser';
import type { AnalyticsService } from '../services/analytics';
import type { AuditEntry, AuditService } from '../services/audit';
import type { EgrulService } from '../services/egrul';
import type { SourceRegistry, SourceStatus } from '../sources/registry';
import type { EmptyAction, FinancialsDto, SearchDates, SearchResponse, SupplierCardDto, SupplierSummary } from './dto';
import { deriveFacts } from './facts';
import type { Coverage, Evidence, SupplierRow } from './model';
import { rowProvenance, toCard, toSummary } from './present';
import { buildReasons, hardFilter, scoreSupplier } from './ranking';
import type { DataMode, SupplierRepository } from './repository';
import type { SupplierResolver } from './resolver';

export interface OpenDataImport {
  dataset: string;
  source: string;
  title: string;
  dataDate: string;
  rowsMatched: number;
  rowsTotal?: number;
}

export const MAX_RESULTS = 5;

/** Налоговые наборы ФНС и отчётность: их версия — «дата налоговых сведений» в выдаче (реестр поддержки МСП — не налоги). */
const FACT_SOURCES = new Set(['FNS_PB', 'FNS_REVEXP']);

/** Дата реестра МСП и самая свежая дата налоговых наборов из журнала импорта. */
export function searchDates(imports: OpenDataImport[]): SearchDates {
  const facts = imports.filter((i) => FACT_SOURCES.has(i.source)).map((i) => i.dataDate).sort();
  return { registryDate: imports.find((i) => i.dataset === 'rsmp')?.dataDate ?? null, factsDate: facts.at(-1) ?? null };
}

export interface SearchContext {
  userId: string | null;
  origin: 'miniapp' | 'bot';
  requestId?: string;
  /** false — предпросмотр в боте: не считаем отдельным начатым поиском в метриках. */
  track?: boolean;
}

export interface SearchServiceDeps {
  db: Db;
  repo: SupplierRepository;
  resolver: SupplierResolver;
  sources: SourceRegistry;
  catalog: Catalog;
  analytics: AnalyticsService;
  audit: AuditService;
  log: Logger;
  /** ЕГРЮЛ по API: запрашивается для лучших кандидатов выдачи и открытых карточек. */
  egrul?: EgrulService;
  egrulTop?: number;
  demoTrustManual: boolean;
  dataMode?: DataMode;
  now?: () => Date;
}

/** Сколько ждать ответа ЕГРЮЛ во время поиска и открытия карточки. */
const EGRUL_DEADLINE_MS = 2500;

export class SearchService {
  private readonly now: () => Date;
  private importsCache: { at: number; items: OpenDataImport[] } | null = null;

  constructor(private readonly d: SearchServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  get dataMode(): DataMode {
    return this.d.dataMode ?? 'all';
  }

  /** Загруженные наборы открытых данных (кэш 5 минут). */
  async imports(): Promise<OpenDataImport[]> {
    if (this.importsCache && Date.now() - this.importsCache.at < 300_000) return this.importsCache.items;
    const items = await this.d.repo.openDataImports().catch(() => []);
    this.importsCache = { at: Date.now(), items };
    return items;
  }

  /** Источники, по которым для реальных компаний действительно есть данные. */
  private async coverage(): Promise<Coverage> {
    const imports = await this.imports();
    return new Set([...imports.map((i) => i.source), ...this.d.sources.officialLive]);
  }

  private officialWarnings(results: SupplierSummary[], q: SearchQuery | null, imports: OpenDataImport[]): string[] {
    const official = results.filter((r) => !r.isManualTestData);
    if (!official.length) return [];
    const rsmp = imports.find((i) => i.dataset === 'rsmp');
    const uncovered = new Set(official.flatMap((r) => r.uncovered ?? []));
    // Декларации и сертификаты — один реестр Росаккредитации, ГИСП — один источник: не повторяем название дважды
    const names = [...new Set([...uncovered].map((id) => (id.startsWith('FSA_') ? 'Росаккредитация' : id.startsWith('GISP') ? 'ГИСП' : this.d.catalog.source(id).name)))];
    const out = [
      `Реальные компании из открытых данных ФНС${rsmp ? ` (реестр МСП на ${rsmp.dataDate.split('-').reverse().join('.')})` : ''}.${names.length ? ` Не подключены: ${names.join(', ')} — сведения из них не проверены.` : ''}`,
    ];
    if (q?.certificate === 'REQUIRED' && (uncovered.has('FSA_DECL') || uncovered.has('FSA_CERT'))) {
      out.push('Фильтр «Нужны документы» не применён к компаниям из открытых данных: реестр Росаккредитации не подключён. Запросите документы у поставщика.');
    }
    if (q?.russianOnly && uncovered.has('GISP_PP719')) out.push('Фильтр «Российская промышленная продукция» не применён к компаниям из открытых данных: реестр ГИСП не подключён.');
    return out;
  }

  /** Факты, жёсткие фильтры и оценка по одной компании. null — компания исключена (причина в exclusions). */
  private evaluate(s: SupplierRow, ev: Evidence, q: SearchQuery, coverage: Coverage, now: Date, exclusions: Record<string, number>): SupplierSummary | null {
    const f = deriveFacts(s, ev, q, this.d.catalog, now, this.d.demoTrustManual, coverage);
    const hf = hardFilter(s, f, q, this.d.catalog);
    if (hf.excluded) {
      exclusions[hf.reason!] = (exclusions[hf.reason!] ?? 0) + 1;
      return null;
    }
    return toSummary(s, f, scoreSupplier(s, f, q, now), buildReasons(s, f, q, this.d.catalog), this.d.catalog, now);
  }

  /**
   * ЕГРЮЛ для лучших кандидатов: запрашиваем, пересчитываем их с обновлёнными сведениями
   * (ликвидированные отсеются жёстким фильтром) и заново сортируем выдачу.
   */
  private async withEgrul(passed: SupplierSummary[], q: SearchQuery, coverage: Coverage, now: Date, exclusions: Record<string, number>): Promise<SupplierSummary[]> {
    const egrul = this.d.egrul;
    if (!egrul?.enabled) return passed;
    const top = passed.slice(0, this.d.egrulTop ?? 10).filter((r) => !r.isManualTestData);
    const { refreshed } = await egrul.refresh(top.map((r) => r.inn), { deadlineMs: EGRUL_DEADLINE_MS });
    if (!refreshed.length) return passed;
    const ids = top.filter((r) => refreshed.includes(r.inn)).map((r) => r.id);
    const [rows, { evidence }] = await Promise.all([this.d.repo.byIds(ids), this.d.resolver.resolve(refreshed, 'search')]);
    const updated = new Map<string, SupplierSummary | null>(rows.map((s) => [s.id, this.evaluate(s, evidence[s.inn], q, coverage, now, exclusions)]));
    return passed
      .map((p) => (updated.has(p.id) ? updated.get(p.id)! : p))
      .filter((p): p is SupplierSummary => !!p)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
  }

  /** Свежие сведения ЕГРЮЛ перед показом карточки или сравнения. Возвращает строки поставщиков с учётом обновления. */
  private async refreshRows(rows: SupplierRow[]): Promise<SupplierRow[]> {
    if (!this.d.egrul?.enabled) return rows;
    const official = rows.filter((r) => r.source_type === 'OFFICIAL');
    const { refreshed } = await this.d.egrul.refresh(official.map((r) => r.inn), { deadlineMs: EGRUL_DEADLINE_MS });
    if (!refreshed.length) return rows;
    const fresh = new Map((await this.d.repo.byIds(rows.filter((r) => refreshed.includes(r.inn)).map((r) => r.id))).map((r) => [r.id, r]));
    return rows.map((r) => fresh.get(r.id) ?? r);
  }

  /** Если товар введён текстом, сопоставляем его со справочником синонимов. */
  normalizeQuery(q: SearchQuery): SearchQuery {
    const out = { ...q };
    if (out.productId) {
      const p = this.d.catalog.product(out.productId);
      if (p) {
        out.categoryId = p.categoryId;
        if (!out.text) out.text = p.name.toLowerCase();
      } else out.productId = null;
    }
    if (!out.categoryId && out.text) {
      const m = matchProduct(out.text, this.d.catalog)[0];
      if (m && m.confidence >= 0.6) {
        out.categoryId = m.categoryId;
        out.productId = m.productId;
      }
    }
    if (out.categoryId && !this.d.catalog.category(out.categoryId)) out.categoryId = null;
    if (out.regionCode && !this.d.catalog.region(out.regionCode)) out.regionCode = null;
    if (out.regionCode === 'RU') out.strictRegion = false;
    const cat = this.d.catalog.category(out.categoryId);
    if (out.russianOnly && cat && !cat.industrial) out.russianOnly = false;
    return out;
  }

  describe(q: SearchQuery): SearchResponse['queryLabel'] {
    const product = this.d.catalog.product(q.productId)?.name ?? this.d.catalog.category(q.categoryId)?.name ?? q.text ?? '';
    const region = this.d.catalog.region(q.regionCode)?.name ?? 'Вся Россия';
    const unit = q.volume ? this.d.catalog.unit(q.volume.unit)?.short ?? q.volume.unit : '';
    const op = q.volume ? { lte: 'до', gte: 'от', eq: '' }[q.volume.operator] : '';
    return {
      product,
      region,
      supplierType: SUPPLIER_PREF_LABEL[q.supplierType],
      volume: q.volume ? `${op} ${q.volume.value} ${unit}`.trim() : null,
      certificate: CERTIFICATE_LABEL[q.certificate],
    };
  }

  private activeFilters(q: SearchQuery): SearchResponse['activeFilters'] {
    const l = this.describe(q);
    const out = [{ key: 'product', label: l.product }];
    out.push({ key: 'region', label: q.strictRegion ? `${l.region}, строго` : l.region });
    if (q.supplierType !== 'ANY') out.push({ key: 'supplierType', label: l.supplierType });
    if (l.volume) out.push({ key: 'volume', label: l.volume });
    if (q.certificate === 'REQUIRED') out.push({ key: 'certificate', label: 'нужны документы' });
    if (q.russianOnly) out.push({ key: 'russianOnly', label: 'ПП РФ №719' });
    return out;
  }

  private warnings(statuses: SourceStatus[], demo: boolean): string[] {
    const w: string[] = [];
    if (statuses.some((s) => s.status === 'failed')) {
      w.push('Часть сведений сейчас недоступна. Мы показали результаты по другим источникам. Дата последней успешной проверки указана в карточке.');
    }
    if (demo) w.push('Демо-версия: сведения из ручной тестовой базы, а не из официальных реестров.');
    return w;
  }

  async search(input: SearchQuery, ctx: SearchContext): Promise<SearchResponse> {
    const stopTimer = searchLatency.startTimer();
    const started = Date.now();
    const now = this.now();
    const q = this.normalizeQuery(input);
    const searchId = crypto.randomUUID();
    const base = { searchId, query: q, queryLabel: this.describe(q), activeFilters: this.activeFilters(q), demo: false };

    if (!q.categoryId) {
      const similar = matchProduct(q.text, this.d.catalog);
      const categories = (similar.length ? similar.map((m) => this.d.catalog.category(m.categoryId)!) : this.d.catalog.data.categories)
        .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
        .map((c) => ({ id: c.id, name: c.name }));
      searches.inc({ result: 'empty', origin: ctx.origin });
      if (ctx.track !== false) {
        this.d.analytics.track('search_started', { userId: ctx.userId, searchId, props: { total: 0, shown: 0, latencyMs: Date.now() - started, origin: ctx.origin, reason: 'product_not_recognized' } });
      }
      stopTimer();
      const imports = await this.imports();
      return {
        ...base,
        total: 0,
        counts: { total: 0, evaluated: 0, matched: 0, shown: 0, isEstimate: false },
        dates: searchDates(imports),
        results: [],
        dataDate: null,
        sources: [],
        dataSources: imports,
        warnings: [],
        empty: {
          reason: 'product_not_recognized',
          message: 'Не удалось сопоставить товар со справочником. Выберите одну из категорий справочника или опишите товар иначе.',
          actions: [
            { id: 'edit_product', label: 'Изменить название товара' },
            { id: 'pick_category', label: 'Выбрать похожую категорию', categories },
            { id: 'new_search', label: 'Новый поиск' },
          ],
        },
      };
    }

    // Дешёвые фильтры и предварительный порядок — в SQL; адаптеры опрашиваются только для лучших кандидатов
    const candidateOptions = {
      categoryId: q.categoryId,
      productId: q.productId,
      dataMode: this.dataMode,
      regionCode: q.regionCode,
      strictRegion: q.strictRegion,
      neighbors: q.regionCode ? this.d.catalog.neighbors(q.regionCode) : [],
      manufacturerOnly: q.supplierType === 'MANUFACTURER_ONLY',
    };
    const [candidates, inCategory, coverage, imports] = await Promise.all([
      this.d.repo.candidates(candidateOptions),
      this.d.repo.countByCategory(candidateOptions),
      this.coverage(),
      this.imports(),
    ]);

    const { evidence, statuses } = await this.d.resolver.resolve(
      candidates.map((s) => s.inn),
      'search',
    );

    const exclusions: Record<string, number> = {};
    let passed: SupplierSummary[] = [];
    for (const s of candidates) {
      const summary = this.evaluate(s, evidence[s.inn], q, coverage, now, exclusions);
      if (summary) passed.push(summary);
    }
    passed.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
    passed = await this.withEgrul(passed, q, coverage, now, exclusions);
    const results = passed.slice(0, MAX_RESULTS);
    const dataDate = results.map((r) => r.checkedAt).sort().at(-1) ?? null;
    const latencyMs = Date.now() - started;
    stopTimer();

    searches.inc({ result: results.length ? 'nonempty' : 'empty', origin: ctx.origin });
    if (ctx.track !== false) {
      this.d.analytics.track('search_started', {
        userId: ctx.userId,
        searchId,
        props: {
          total: passed.length,
          shown: results.length,
          latencyMs,
          origin: ctx.origin,
          legalConfirmed: results.filter((r) => r.legalStatus.refreshed && r.legalStatus.value === 'ACTIVE').length,
          typeDefined: results.filter((r) => r.supplierType !== 'UNKNOWN').length,
          staleSources: statuses.filter((s) => s.status === 'failed').length,
          exclusions,
        },
      });
    }
    if (ctx.userId && ctx.track !== false) {
      this.d.db
        .query('INSERT INTO search_history (max_user_id, query, results_count, origin) VALUES ($1, $2, $3, $4)', [ctx.userId, JSON.stringify(q), passed.length, ctx.origin])
        .catch((err) => this.d.log.warn({ err: err.message }, 'history insert failed'));
    }
    this.d.audit.record(results.map((r) => this.auditEntry(r, 'search', ctx)));

    // Кандидаты сверх лимита предварительного отбора не проверялись адаптерами: подходящих может быть больше
    const total = Math.max(inCategory, candidates.length);
    return {
      ...base,
      demo: results.some((r) => r.isManualTestData),
      total,
      counts: { total, evaluated: candidates.length, matched: passed.length, shown: results.length, isEstimate: candidates.length < total },
      dates: searchDates(imports),
      results,
      dataDate,
      sources: statuses,
      dataSources: imports,
      warnings: [
        ...this.warnings(statuses, results.some((r) => r.isManualTestData)),
        ...this.officialWarnings(results, q, imports),
        ...(results.length > 0 && results.length < 3 && q.strictRegion ? ['Найдено меньше трёх вариантов. Попробуйте расширить регион.'] : []),
      ],
      empty: results.length ? null : { reason: 'no_results', message: 'По запросу ничего не найдено.', actions: this.emptyActions(q, exclusions) },
    };
  }

  emptyActions(q: SearchQuery, exclusions: Record<string, number>): EmptyAction[] {
    const actions: EmptyAction[] = [];
    if (q.supplierType === 'MANUFACTURER_ONLY') actions.push({ id: 'relax_type', label: 'Убрать фильтр «только производитель»', patch: { supplierType: 'MANUFACTURER_OR_DISTRIBUTOR' } });
    else if (q.supplierType === 'MANUFACTURER_OR_DISTRIBUTOR' && exclusions['торговый посредник'])
      actions.push({ id: 'relax_type_any', label: 'Показать любых поставщиков', patch: { supplierType: 'ANY' } });
    if (q.strictRegion) actions.push({ id: 'expand_region', label: 'Расширить регион', patch: { strictRegion: false } });
    else if (q.regionCode && q.regionCode !== 'RU') actions.push({ id: 'all_russia', label: 'Искать по всей России', patch: { regionCode: 'RU' } });
    if (q.certificate === 'REQUIRED') actions.push({ id: 'relax_docs', label: 'Показать без обязательных документов', patch: { certificate: 'PREFERRED' } });
    if (q.russianOnly) actions.push({ id: 'relax_pp719', label: 'Убрать фильтр «российская продукция»', patch: { russianOnly: false } });
    actions.push({ id: 'edit_product', label: 'Изменить название товара' });
    const cat = this.d.catalog.category(q.categoryId);
    actions.push({
      id: 'pick_category',
      label: 'Выбрать похожую категорию',
      categories: this.d.catalog.data.categories.filter((c) => c.id !== cat?.id).map((c) => ({ id: c.id, name: c.name })),
    });
    actions.push({ id: 'new_search', label: 'Новый поиск' });
    return actions;
  }

  private auditEntry(r: SupplierSummary, context: AuditEntry['context'], ctx: SearchContext): AuditEntry {
    const fields = [
      { field: 'legal_status', p: r.legalStatus.provenance },
      { field: 'sme_status', p: r.sme.provenance },
      { field: 'gisp', p: r.gisp.provenance },
      ...r.documents.items.map((d) => ({ field: `document:${d.number}`, p: d.provenance })),
      ...r.risks.map((x) => ({ field: `risk:${x.kind}`, p: x.provenance })),
    ]
      .filter((x) => x.p)
      .map((x) => ({ field: x.field, source: x.p!.source, sourceType: x.p!.sourceType, checkedAt: x.p!.checkedAt }));
    return { requestId: ctx.requestId, userHash: hashUserId(ctx.userId), supplierId: r.id, context, fields };
  }

  private async summarize(rows: SupplierRow[], q: SearchQuery | null, scope: 'search' | 'card') {
    const now = this.now();
    const { evidence, statuses } = await this.d.resolver.resolve(
      rows.map((r) => r.inn),
      scope,
    );
    const coverage = await this.coverage();
    const effective: SearchQuery =
      q ?? { text: '', productId: null, categoryId: null, regionCode: null, strictRegion: false, supplierType: 'ANY', volume: null, certificate: 'PREFERRED', russianOnly: false };
    const items = rows.map((s) => {
      const ev = evidence[s.inn];
      const qq = effective.categoryId ? effective : { ...effective, categoryId: s.products[0]?.category_id ?? null };
      const f = deriveFacts(s, ev, qq, this.d.catalog, now, this.d.demoTrustManual, coverage);
      const scored = scoreSupplier(s, f, qq, now);
      const summary = toSummary(s, f, scored, buildReasons(s, f, qq, this.d.catalog), this.d.catalog, now);
      return { s, ev, f, summary, qq };
    });
    return { items, statuses, now };
  }

  async card(id: string, q: SearchQuery | null, ctx: SearchContext): Promise<SupplierCardDto | null> {
    const [found] = await this.d.repo.byIds([id]);
    if (!found) return null;
    const [s] = await this.refreshRows([found]);
    const nq = q ? this.normalizeQuery(q) : null;
    const { items, statuses, now } = await this.summarize([s], nq, 'card');
    const it = items[0];
    const catId = it.qq.categoryId ?? s.products[0]?.category_id;
    const req = catId ? await this.d.sources.call(this.d.sources.requirements, { categoryId: catId }) : null;
    const card = toCard({
      s,
      ev: it.ev,
      f: it.f,
      summary: it.summary,
      query: it.qq,
      statuses,
      requirements: req && req.ok ? req.data : null,
      catalog: this.d.catalog,
      sources: this.d.sources,
      imports: await this.imports(),
      now,
    });
    this.d.audit.record([this.auditEntry(it.summary, 'card', ctx)]);
    return card;
  }

  async compare(ids: string[], q: SearchQuery | null, ctx: SearchContext) {
    const rows = await this.refreshRows(await this.d.repo.byIds(ids.slice(0, 3)));
    const nq = q ? this.normalizeQuery(q) : null;
    const { items, statuses } = await this.summarize(rows, nq, 'search');
    this.d.audit.record(items.map((i) => this.auditEntry(i.summary, 'compare', ctx)));
    return {
      suppliers: items.map((i) => ({
        ...i.summary,
        okvedMain: i.s.okved_main,
        okvedMatch: i.f.okvedMatch,
        sources: [...new Set([i.summary.legalStatus.provenance?.sourceName, i.summary.sme.provenance?.sourceName, i.summary.gisp.provenance?.sourceName, ...i.summary.documents.items.map((d) => d.provenance.sourceName)].filter(Boolean))],
      })),
      sources: statuses,
      warnings: [
        ...this.warnings(statuses, items.some((i) => i.summary.isManualTestData)),
        ...this.officialWarnings(items.map((i) => i.summary), nq ?? items[0]?.qq ?? null, await this.imports()),
      ],
    };
  }

  async financials(id: string): Promise<FinancialsDto | null> {
    const [s] = await this.d.repo.byIds([id]);
    if (!s) return null;
    const res = await this.d.sources.call(this.d.sources.finance, { inns: [s.inn] });
    const link = this.d.sources.finance.externalLink({ inn: s.inn });
    if (!res.ok) return { status: 'unavailable', message: 'ГИР БО сейчас недоступен. Попробуйте позже или откройте источник.', periods: [], link };
    const rows = res.data[s.inn] ?? [];
    if (!rows.length) {
      const message = s.source_type === 'OFFICIAL'
        ? s.entity_type === 'IP'
          ? 'Индивидуальные предприниматели не сдают бухгалтерскую отчётность в ГИР БО.'
          : 'В открытых данных ФНС о доходах и расходах за прошлый год сведений по компании нет.'
        : 'Бухгалтерская отчётность в подключённом источнике не найдена.';
      return { status: 'not_found', message, periods: [], link };
    }
    const now = this.now();
    const num = (v: string | null) => (v === null ? null : Number(v));
    return {
      status: 'ok',
      message: null,
      link,
      periods: rows.map((r) => ({
        year: r.period_year,
        unit: (r.unit ?? 'THOUSAND_RUB') as 'RUB' | 'THOUSAND_RUB',
        revenue: num(r.revenue),
        expenses: num(r.expenses ?? null),
        assets: num(r.assets),
        profit: num(r.profit),
        liabilities: num(r.liabilities),
        capital: num(r.capital),
        provenance: rowProvenance(r, this.d.catalog, now),
      })),
    };
  }

  resultsTitle(total: number): string {
    return `${total} ${plural(total, ['поставщик', 'поставщика', 'поставщиков'])}`;
  }
}
