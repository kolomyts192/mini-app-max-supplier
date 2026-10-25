import { ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { HistoryItem, SearchQuery, SupplierTypePref } from '../api/types';
import { EMPTY_QUERY } from '../api/types';
import { haptic } from '../bridge';
import { MissingProductSheet, RegionSheet } from '../components/sheets';
import { Button, Chip, ICON_S, IconButton, StickyActionBar, ThemeToggle, Toggle } from '../components/ui';
import { fmt, useOverview } from '../hooks';
import { encodeQuery, useApp } from '../store';
import { formatDate, plural, sourcesList } from '../utils';

const SUPPLIER_TYPES: { value: SupplierTypePref; label: string }[] = [
  { value: 'ANY', label: 'Любой' },
  { value: 'MANUFACTURER_OR_DISTRIBUTOR', label: 'Завод или дилер' },
  { value: 'MANUFACTURER_ONLY', label: 'Только завод' },
];

type Suggestion = { productId: string | null; categoryId: string; name: string; categoryName: string };

const TOP_CATEGORIES = 8;

/** Главный экран и поиск (ТЗ 7.1). Параметры предзаполняются из search_token, профиль компании не запрашивается. */
export function SearchScreen() {
  const navigate = useNavigate();
  const { catalog, session, form, setForm, replaceForm } = useApp();
  const { data: overview } = useOverview();
  const [suggest, setSuggest] = useState<Suggestion[]>([]);
  const [focus, setFocus] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const initial = useRef(JSON.stringify(form));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.history().then((r) => setHistory(r.items)).catch(() => undefined);
    api.selections().then((r) => setSavedCount(r.items.length)).catch(() => undefined);
    if (window.location.hash === '#product') inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = form.text.trim();
    if (q.length < 2 || form.productId) {
      setSuggest([]);
      return;
    }
    const t = setTimeout(() => {
      api.suggest(q).then((r) => setSuggest(r.items)).catch(() => setSuggest([]));
    }, 250);
    return () => clearTimeout(t);
  }, [form.text, form.productId]);

  const category = catalog?.categories.find((c) => c.id === form.categoryId) ?? null;
  const region = catalog?.regions.find((r) => r.code === form.regionCode) ?? null;
  const canSearch = form.text.trim().length >= 2 || !!form.categoryId;
  const unitDefault = category?.defaultUnit ?? 't';
  const counts = useMemo(() => new Map(overview?.byCategory.map((c) => [c.id, c.count]) ?? []), [overview]);
  const [allCategories, setAllCategories] = useState(false);
  // Крупные категории сверху; выбранная категория всегда видна, даже если свёрнута
  const sortedCategories = useMemo(
    () => [...(catalog?.categories ?? [])].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)),
    [catalog, counts],
  );
  const visibleCategories = allCategories
    ? sortedCategories
    : sortedCategories.filter((c, i) => i < TOP_CATEGORIES || c.id === form.categoryId);
  const rsmp = session?.data?.imports.find((i) => i.dataset === 'rsmp');
  const realData = session?.data?.mode !== 'test' && !!rsmp;
  // Какие реестры ещё не дают сведений: по журналу импорта и живым API (ЕГРЮЛ по ключу DaData)
  const connected = new Set([...(session?.data?.imports ?? []).map((i) => i.source), ...(session?.data?.live ?? [])]);
  const pending = sourcesList(
    [['FNS_EGRUL'], ['GISP', 'GISP_PP719'], ['FSA_DECL', 'FSA_CERT']].filter((ids) => !ids.some((id) => connected.has(id))).map((ids) => ids[0]),
  );

  const [volumeText, setVolumeText] = useState(form.volume ? String(form.volume.value).replace('.', ',') : '');
  const [volumeUnit, setVolumeUnit] = useState(form.volume?.unit ?? unitDefault);
  const [volumeOp, setVolumeOp] = useState<'lte' | 'gte' | 'eq'>(form.volume?.operator ?? 'lte');
  const setVolume = (patch: Partial<{ value: number | null; unit: string; operator: 'lte' | 'gte' | 'eq' }>) => {
    const cur = form.volume ?? { value: 0, unit: volumeUnit, operator: volumeOp };
    const next = { ...cur, ...patch };
    setForm({ volume: next.value ? { value: next.value, unit: next.unit, operator: next.operator } : null });
  };

  const pickCategory = (id: string) => {
    haptic('selection');
    const c = catalog!.categories.find((x) => x.id === id)!;
    if (form.categoryId === id && !form.productId) setForm({ categoryId: null, productId: null, text: '' });
    else setForm({ categoryId: id, productId: null, text: c.name.toLowerCase(), russianOnly: c.industrial ? form.russianOnly : false });
    if (!form.volume) setVolumeUnit(c.defaultUnit);
  };

  const pickProduct = (productId: string, categoryId: string, name: string) => {
    haptic('selection');
    setForm({ productId, categoryId, text: name.toLowerCase() });
    setSuggest([]);
  };

  const submit = () => {
    if (!canSearch) return;
    const q: SearchQuery = { ...form, text: form.text.trim() };
    if (JSON.stringify(q) !== initial.current) void api.event('filters_changed', null, { from: 'search_form' });
    replaceForm(q);
    navigate(`/results?${encodeQuery(q)}`);
  };

  const recent = history.slice(0, 3);
  if (!catalog) return null;

  return (
    <div className="screen screen--with-bar">
      <header className="topbar">
        <div className="wordmark">
          Проверенный <span>поставщик</span>
        </div>
        <div className="topbar__actions">
          <button type="button" className="link-arrow" onClick={() => navigate('/dashboard')}>
            Обзор <ArrowUpRight size={18} strokeWidth={2} aria-hidden />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <section className="hero fade-in" aria-labelledby="hero-title">
        <h1 className="hero__title" id="hero-title">
          Найдём проверенного поставщика
        </h1>
        <p className="hero__lead">
          {realData && overview
            ? `${fmt(overview.totals.companies)} ${plural(overview.totals.companies, ['компания', 'компании', 'компаний'])} из реестра МСП ФНС. Без регистрации, рекламы и платных мест в выдаче.`
            : 'Покажем 3–5 компаний и откуда о них сведения. Без регистрации, рекламы и платных мест в выдаче.'}
        </p>
        <div style={{ marginTop: 28 }}>
          <label className="sr-only" htmlFor="product">
            Товар
          </label>
          <div className="input-wrap">
            <input
              id="product"
              ref={inputRef}
              className="input"
              placeholder="Товар, например фасадная краска"
              value={form.text}
              autoComplete="off"
              enterKeyHint="search"
              onFocus={() => setFocus(true)}
              onBlur={() => setTimeout(() => setFocus(false), 150)}
              onChange={(e) => setForm({ text: e.target.value, productId: null, categoryId: null })}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {form.text ? (
              <IconButton label="Очистить" className="input-wrap__clear" onClick={() => setForm({ text: '', productId: null, categoryId: null })}>
                <X {...ICON_S} />
              </IconButton>
            ) : (
              <span className="input-wrap__clear icon-btn" aria-hidden>
                <SearchIcon {...ICON_S} />
              </span>
            )}
          </div>
          {focus && suggest.length > 0 && (
            <div className="suggest" role="listbox" aria-label="Подсказки">
              {suggest.map((s) => (
                <button
                  key={`${s.categoryId}:${s.productId}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="suggest__item"
                  style={{ color: '#0e1621' }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (s.productId ? pickProduct(s.productId, s.categoryId, s.name) : pickCategory(s.categoryId))}
                >
                  <span className="t-body">{s.name}</span>
                  <span className="t-caption" style={{ color: '#4b5163' }}>
                    {s.productId ? s.categoryName : 'Вся категория'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="hero__meta">
          {realData && rsmp ? `Данные ФНС на ${formatDate(rsmp.dataDate)}${pending ? ` · ${pending} подключаются` : ''}` : 'Демо-версия: вымышленные компании из тестовой базы'}
        </div>
      </section>

      <section className="section" aria-labelledby="cat-title">
        <div className="row row--between" style={{ alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="t-h2" id="cat-title">
            Категории
          </h2>
          {realData && <span className="t-caption faint">компаний в базе</span>}
        </div>
        <div className="cat-list" role="group" aria-label="Категории">
          {visibleCategories.map((c, i) => (
            <button key={c.id} type="button" className="cat-row" aria-pressed={form.categoryId === c.id} onClick={() => pickCategory(c.id)}>
              <span className="cat-row__idx">{String(i + 1).padStart(2, '0')}</span>
              <span className="cat-row__name">{c.name}</span>
              <span className="cat-row__count">{counts.has(c.id) ? fmt(counts.get(c.id)!) : ''}</span>
            </button>
          ))}
          {sortedCategories.length > TOP_CATEGORIES && (
            <button type="button" className="show-more" aria-expanded={allCategories} onClick={() => setAllCategories((v) => !v)}>
              {allCategories ? 'Свернуть' : `Все категории · ${sortedCategories.length}`}
              <ChevronDown size={18} strokeWidth={2} style={{ transform: allCategories ? 'rotate(180deg)' : undefined }} aria-hidden />
            </button>
          )}
        </div>

        {category && (
          <div className="fade-in" style={{ marginTop: 28 }}>
            <div className="field__label">Товар</div>
            <div className="chips">
              {category.products.map((p) => (
                <Chip key={p.id} selected={form.productId === p.id} onClick={() => (form.productId === p.id ? setForm({ productId: null, text: category.name.toLowerCase() }) : pickProduct(p.id, category.id, p.name))}>
                  {p.name}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="where-title">
        <h2 className="t-h2 section__title" id="where-title">
          Где и у кого
        </h2>
        <div className="stack-6">
          <div>
            <span className="field__label">Регион</span>
            <button type="button" className="select-field" onClick={() => setRegionOpen(true)} aria-haspopup="dialog">
              <span className={`select-field__value ${region ? '' : 'select-field__placeholder'}`}>{region?.name ?? 'Вся Россия'}</span>
              <ChevronDown {...ICON_S} aria-hidden />
            </button>
          </div>

          <div>
            <span className="field__label">Тип поставщика</span>
            <div className="segmented" role="group" aria-label="Тип поставщика">
              {SUPPLIER_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-pressed={form.supplierType === t.value}
                  onClick={() => {
                    haptic('selection');
                    setForm({ supplierType: t.value });
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="field__hint">Завод определяем по документам и заявленной продукции, а не по одному ОКВЭД.</p>
          </div>

          <div>
            <span className="field__label">Объём</span>
            <div className="volume-row">
              <select
                className="native-select"
                aria-label="Условие объёма"
                value={volumeOp}
                onChange={(e) => {
                  const op = e.target.value as 'lte' | 'gte' | 'eq';
                  setVolumeOp(op);
                  if (form.volume) setVolume({ operator: op });
                }}
              >
                <option value="lte">до</option>
                <option value="gte">от</option>
                <option value="eq">ровно</option>
              </select>
              <input
                className="input num"
                inputMode="decimal"
                placeholder="Не важно"
                aria-label="Объём"
                value={volumeText}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^\d.,]/g, '').slice(0, 12);
                  setVolumeText(raw);
                  const v = Number(raw.replace(',', '.'));
                  setVolume({ value: Number.isFinite(v) && v > 0 ? v : null, unit: volumeUnit, operator: volumeOp });
                }}
              />
              <select
                className="native-select"
                aria-label="Единица измерения"
                value={volumeUnit}
                onChange={(e) => {
                  setVolumeUnit(e.target.value);
                  if (form.volume) setVolume({ unit: e.target.value });
                }}
              >
                {catalog.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.short}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {region && region.code !== 'RU' && (
              <Toggle
                checked={form.strictRegion}
                onChange={(v) => setForm({ strictRegion: v })}
                label="Только этот регион"
                hint={form.strictRegion ? 'Соседние регионы не попадут в подборку' : 'Соседние регионы покажем ниже'}
              />
            )}
            <Toggle checked={form.certificate === 'REQUIRED'} onChange={(v) => setForm({ certificate: v ? 'REQUIRED' : 'PREFERRED' })} label="Нужны документы" hint="Действующая декларация или сертификат на товар" />
            {(!category || category.industrial) && (
              <Toggle checked={form.russianOnly} onChange={(v) => setForm({ russianOnly: v })} label="Российская продукция" hint="Реестр промышленной продукции ГИСП, ПП РФ №719" />
            )}
          </div>

          <button type="button" className="btn btn--text" style={{ padding: 0, justifyContent: 'flex-start' }} onClick={() => setMissingOpen(true)}>
            Нет вашего товара? Напишите нам
          </button>
        </div>
      </section>

      {overview && realData && (
        <section className="section">
          <button type="button" className="teaser" onClick={() => navigate('/dashboard')}>
            <span className="t-overline" style={{ color: 'rgba(244,242,255,.6)' }}>
              Обзор рынка
            </span>
            <div className="teaser__row">
              <div>
                <div className="hero__number" style={{ fontSize: 72, lineHeight: '64px' }}>
                  {fmt(overview.totals.companies)}
                </div>
                <div className="t-body" style={{ color: 'rgba(244,242,255,.72)', marginTop: 8 }}>
                  компаний · {overview.totals.categories} категорий · {overview.totals.regions} {plural(overview.totals.regions, ['регион', 'региона', 'регионов'])}
                </div>
              </div>
              <ArrowRight size={28} strokeWidth={1.5} aria-hidden />
            </div>
          </button>
        </section>
      )}

      {recent.length > 0 && (
        <section className="section" aria-labelledby="recent-title">
          <h2 className="t-h2 section__title" id="recent-title">
            Недавние поиски
          </h2>
          <div>
            {recent.map((h, i) => (
              <button
                key={i}
                type="button"
                className="list-row"
                onClick={() => {
                  replaceForm({ ...EMPTY_QUERY, ...h.query });
                  navigate(`/results?${encodeQuery({ ...EMPTY_QUERY, ...h.query })}`);
                }}
              >
                <span className="grow">
                  <span className="t-body" style={{ fontWeight: 500 }}>
                    {h.queryLabel.product}
                  </span>
                  <span className="t-caption muted" style={{ display: 'block' }}>
                    {h.queryLabel.region} · {h.queryLabel.supplierType}
                  </span>
                </span>
                <ChevronRight {...ICON_S} className="list-row__chevron" aria-hidden />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section" style={{ marginTop: recent.length ? 32 : 56 }}>
        <button type="button" className="list-row" style={{ borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' }} onClick={() => navigate('/saved')}>
          <span className="grow">
            <span className="t-body" style={{ fontWeight: 600 }}>
              Сохранённые подборки
            </span>
            {savedCount !== null && (
              <span className="t-caption muted" style={{ display: 'block' }}>
                {savedCount ? `${savedCount} ${plural(savedCount, ['подборка', 'подборки', 'подборок'])}` : 'Пока пусто'}
              </span>
            )}
          </span>
          <ChevronRight {...ICON_S} className="list-row__chevron" aria-hidden />
        </button>
      </section>

      <p className="t-caption faint" style={{ marginTop: 32, maxWidth: '38ch' }}>
        Сервис не гарантирует надёжность, качество или наличие товара. Он показывает найденные сведения и их источники.
      </p>

      <StickyActionBar>
        <Button block disabled={!canSearch} onClick={submit}>
          Найти поставщиков
        </Button>
      </StickyActionBar>

      <RegionSheet open={regionOpen} catalog={catalog} value={form.regionCode ?? 'RU'} onSelect={(code) => setForm({ regionCode: code === 'RU' ? null : code, strictRegion: code === 'RU' ? false : form.strictRegion })} onClose={() => setRegionOpen(false)} />
      <MissingProductSheet open={missingOpen} onClose={() => setMissingOpen(false)} />
    </div>
  );
}
