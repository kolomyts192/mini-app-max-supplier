import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Overview } from '../api/types';
import { EMPTY_QUERY } from '../api/types';
import { Button, Skeleton, StateView, ThemeToggle } from '../components/ui';
import { fmt, useOverview } from '../hooks';
import { encodeQuery, useApp } from '../store';
import { formatDate, plural } from '../utils';

const TOP_CATEGORIES = 8;

/** Кто публикует набор открытых данных. */
const publisher = (source: string) => (source === 'FAS_RNP' ? 'ФАС' : source.startsWith('FSA_') ? 'Росаккредитация' : 'ФНС');

const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

/** Горизонтальные полосы: одна серия, значение на конце, подсказка при наведении и фокусе. */
function Bars({ items, total, onPick }: { items: { key: string; label: string; count: number }[]; total: number; onPick?: (key: string) => void }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="bars">
      {items.map((i) => {
        const share = pct(i.count, total);
        const Tag = onPick ? 'button' : 'div';
        return (
          <li key={i.key}>
            <Tag
              type={onPick ? 'button' : undefined}
              className="bar-row"
              onClick={onPick ? () => onPick(i.key) : undefined}
              aria-label={`${i.label}: ${fmt(i.count)}, ${share}% базы`}
            >
              <span className="bar-row__label">{i.label}</span>
              <span className="bar-row__value">
                {fmt(i.count)}
                <small>{share}%</small>
              </span>
              <span className="bar-row__track" aria-hidden>
                <span className="bar-row__fill" style={{ width: `${(i.count / max) * 100}%`, display: 'block' }} />
              </span>
              <span className="bar-tip" aria-hidden>
                {fmt(i.count)} {plural(i.count, ['компания', 'компании', 'компаний'])} · {share}% базы
              </span>
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}

function SizeMix({ sme }: { sme: Overview['sme'] }) {
  const parts = [
    { key: 'micro', label: 'Микропредприятия', count: sme.micro, color: 'var(--chart-ord-1)' },
    { key: 'small', label: 'Малые', count: sme.small, color: 'var(--chart-ord-2)' },
    { key: 'medium', label: 'Средние', count: sme.medium, color: 'var(--chart-ord-3)' },
  ];
  const total = parts.reduce((a, p) => a + p.count, 0);
  return (
    <div>
      <div className="stack-bar" role="img" aria-label={parts.map((p) => `${p.label}: ${fmt(p.count)}`).join(', ')}>
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <span key={p.key} title={`${p.label}: ${fmt(p.count)} · ${pct(p.count, total)}%`} style={{ flex: `${p.count} 1 0`, background: p.color }} />
          ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.key}>
            <i style={{ background: p.color }} aria-hidden />
            <span>{p.label}</span>
            <span className="num" style={{ fontWeight: 600 }}>
              {fmt(p.count)}
            </span>
            <span className="num faint" style={{ minWidth: 40, textAlign: 'right' }}>
              {pct(p.count, total)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="screen stack-6" aria-busy="true">
      <Skeleton h={14} w="45%" />
      <Skeleton h={110} w="90%" />
      <Skeleton h={240} r={28} />
      <div className="stat-grid">
        <Skeleton h={132} r={20} />
        <Skeleton h={132} r={20} />
      </div>
    </div>
  );
}

/** Дашборд «Обзор рынка»: только агрегаты по базе, без персональных данных. */
export function DashboardScreen() {
  const navigate = useNavigate();
  const { replaceForm } = useApp();
  const { data, error, reload } = useOverview();
  const [allCats, setAllCats] = useState(false);

  if (error && !data)
    return (
      <div className="screen">
        <StateView title="Не удалось загрузить обзор" text="Попробуйте ещё раз через минуту.">
          <Button block onClick={reload}>
            Повторить
          </Button>
        </StateView>
      </div>
    );
  if (!data) return <DashboardSkeleton />;

  const t = data.totals;
  const rsmp = data.imports.find((i) => i.dataset === 'rsmp');
  const real = data.dataMode !== 'test' && !!rsmp;
  const inRegions = data.byRegion.reduce((a, r) => a + r.count, 0);
  const regionsRest = t.regions - data.byRegion.length;
  const sr = data.product.successRate;
  const categories = [...data.byCategory].sort((a, b) => b.count - a.count);

  const openCategory = (id: string) => {
    const name = data.byCategory.find((c) => c.id === id)?.name ?? '';
    const q = { ...EMPTY_QUERY, categoryId: id, text: name.toLowerCase() };
    replaceForm(q);
    navigate(`/results?${encodeQuery(q)}`);
  };
  const openRegion = (code: string) => {
    replaceForm({ ...EMPTY_QUERY, regionCode: code });
    navigate('/');
  };

  return (
    <div className="screen fade-in">
      <div className="topbar" style={{ marginBottom: 8 }}>
        <p className="t-overline">Обзор рынка{rsmp ? ` · данные ФНС на ${formatDate(rsmp.dataDate)}` : ''}</p>
        <ThemeToggle />
      </div>
      <h1 className="t-display" style={{ marginTop: 16 }}>
        Кто производит и поставляет товары для бизнеса
      </h1>
      <p className="t-lead" style={{ marginTop: 20, marginBottom: 0 }}>
        {real ? 'Реальные компании из единого реестра МСП с налоговыми сведениями и отчётностью. Только проверяемые факты, без рейтингов.' : 'Демо-версия на тестовой базе вымышленных компаний.'}
      </p>

      <section className="hero" style={{ marginTop: 40 }} aria-label="Компаний в базе">
        <p className="t-overline" style={{ color: 'var(--on-blue-muted)' }}>
          Компаний в базе
        </p>
        <p className="hero__number" style={{ marginTop: 18 }}>
          {fmt(t.companies)}
        </p>
        <div className="hero__meta">
          {rsmp
            ? `Отобрано из ${fmt(rsmp.rowsTotal ?? 0)} записей реестра МСП по основному ОКВЭД и заявленной продукции · вся Россия`
            : 'Ручная тестовая база вымышленных компаний'}
        </div>
      </section>

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <div className="stat">
          <span className="stat__value">{fmt(t.withReports)}</span>
          <span className="stat__label">сдают отчётность с выручкой</span>
        </div>
        <div className="stat">
          <span className="stat__value">{fmt(t.regions)}</span>
          <span className="stat__label">{plural(t.regions, ['регион', 'региона', 'регионов'])} присутствия</span>
        </div>
        <div className="stat">
          <span className="stat__value">{fmt(t.withEmployees)}</span>
          <span className="stat__label">со сведениями о численности</span>
        </div>
        <div className="stat">
          <span className="stat__value">{fmt(t.declaredManufacturers)}</span>
          <span className="stat__label">сами заявили продукцию в реестре</span>
        </div>
      </div>

      <section className="section" aria-labelledby="d-cat">
        <h2 className="t-h2" id="d-cat">
          По категориям
        </h2>
        <p className="t-caption muted" style={{ margin: '10px 0 8px' }}>
          Нажмите на категорию, чтобы открыть поставщиков.
        </p>
        <Bars items={(allCats ? categories : categories.slice(0, TOP_CATEGORIES)).map((c) => ({ key: c.id, label: c.name, count: c.count }))} total={t.companies} onPick={openCategory} />
        {categories.length > TOP_CATEGORIES && (
          <button type="button" className="show-more" aria-expanded={allCats} onClick={() => setAllCats((v) => !v)}>
            {allCats ? 'Свернуть' : `Показать все · ${categories.length}`}
            <ChevronDown size={18} strokeWidth={2} style={{ transform: allCats ? 'rotate(180deg)' : undefined }} aria-hidden />
          </button>
        )}
      </section>

      <section className="section" aria-labelledby="d-reg">
        <h2 className="t-h2" id="d-reg">
          Где больше всего
        </h2>
        <p className="t-caption muted" style={{ margin: '10px 0 8px' }}>
          Топ регионов по числу компаний{regionsRest > 0 ? `; ещё ${regionsRest} ${plural(regionsRest, ['регион', 'региона', 'регионов'])} — ${fmt(t.companies - inRegions)} компаний` : ''}.
        </p>
        <Bars items={data.byRegion.slice(0, 8).map((r) => ({ key: r.code, label: r.name, count: r.count }))} total={t.companies} onPick={openRegion} />
      </section>

      <section className="section" aria-labelledby="d-size">
        <h2 className="t-h2" id="d-size">
          Размер компаний
        </h2>
        <p className="t-caption muted" style={{ margin: '10px 0 0' }}>
          Категория в реестре МСП: от микропредприятий до средних.
        </p>
        <SizeMix sme={data.sme} />
      </section>

      <section className="section" aria-labelledby="d-src">
        <h2 className="t-h2 section__title" id="d-src">
          Источники
        </h2>
        <ol className="timeline">
          {data.imports.map((i) => (
            <li key={i.dataset}>
              <div className="t-strong">{i.title}</div>
              <div className="t-caption muted num">
                {publisher(i.source)}, открытые данные · на {formatDate(i.dataDate)} · {fmt(i.rowsMatched)} {plural(i.rowsMatched, ['совпадение', 'совпадения', 'совпадений'])}
              </div>
            </li>
          ))}
          {(data.live ?? []).map((l) => (
            <li key={l.id}>
              <div className="t-strong">{l.name}</div>
              <div className="t-caption muted num">
                {l.detail}
                {l.checked ? ` · проверено ${fmt(l.checked)} ${plural(l.checked, ['компания', 'компании', 'компаний'])}` : ''}
              </div>
            </li>
          ))}
          {data.notConnected.map((n) => (
            <li key={n.id} className="is-off">
              <div className="t-strong faint">{n.name}</div>
              <div className="t-caption faint">Не подключён: {n.reason}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="d-prod">
        <h2 className="t-h2" id="d-prod">
          Как работает сервис
        </h2>
        <p className="t-caption muted" style={{ margin: '10px 0 20px' }}>
          За {data.product.periodDays} дней. Успешный поиск — открыта карточка, сохранён поставщик или переход к источнику.
        </p>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat__value">{fmt(data.product.searches)}</span>
            <span className="stat__label">{plural(data.product.searches, ['поиск', 'поиска', 'поисков'])}</span>
          </div>
          <div className="stat">
            <span className="stat__value">{sr === null ? '—' : `${Math.round(sr * 100)}%`}</span>
            <span className="stat__label">успешных поисков</span>
          </div>
          <div className="stat">
            <span className="stat__value">{data.product.nonEmptyShare === null ? '—' : `${Math.round(data.product.nonEmptyShare * 100)}%`}</span>
            <span className="stat__label">с непустой выдачей</span>
          </div>
          <div className="stat">
            <span className="stat__value">{data.product.avgLatencyMs === null ? '—' : `${fmt(data.product.avgLatencyMs)} мс`}</span>
            <span className="stat__label">до первой выдачи</span>
          </div>
        </div>
      </section>

      <p className="t-caption faint" style={{ marginTop: 40, maxWidth: '40ch' }}>
        Порядок выдачи одинаковый для всех. Оплата на него не влияет, рейтинга надёжности нет — только сведения из источников с датой проверки.
      </p>
    </div>
  );
}
