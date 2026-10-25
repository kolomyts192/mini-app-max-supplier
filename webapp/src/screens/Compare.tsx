import { BookmarkPlus, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, NetworkError } from '../api/client';
import type { CompareResponse, CompareSupplier } from '../api/types';
import { EMPTY_QUERY } from '../api/types';
import { haptic } from '../bridge';
import { RoleBadge } from '../components/SupplierCard';
import { QuoteSheet } from '../components/sheets';
import { Button, CardSkeleton, ICON_S, IconButton, Notice, StateView, StickyActionBar } from '../components/ui';
import { decodeQuery, encodeQuery, useApp } from '../store';
import { formatDate, softHyphens } from '../utils';

const ROWS: { label: string; render: (s: CompareSupplier) => React.ReactNode }[] = [
  { label: 'Тип поставщика', render: (s) => <RoleBadge type={s.supplierType} label={s.supplierTypeLabel} /> },
  { label: 'Регион', render: (s) => `${s.city ? `${s.city}, ` : ''}${s.region.name}` },
  {
    label: 'Статус деятельности',
    render: (s) => (
      <span style={{ color: s.legalStatus.value === 'ACTIVE' && s.legalStatus.refreshed ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
        {s.legalStatus.label}
        {!s.legalStatus.refreshed ? ' (не обновлено)' : ''}
      </span>
    ),
  },
  { label: 'ОКВЭД', render: (s) => (s.okvedMain ? `${s.okvedMain.code}${s.okvedMatch ? ' · профильный' : ''}` : '—') },
  { label: 'Статус МСП', render: (s) => s.sme.label },
  { label: 'ГИСП', render: (s) => (s.gisp.found ? `найдено: ${s.gisp.records}${s.gisp.pp719 ? ', ПП РФ №719' : ''}` : 'не найдено') },
  {
    label: 'Документы',
    render: (s) => {
      const { total, active, relevantActive, items } = s.documents;
      if (!total && !items.length) return 'не найдены';
      const certs = items.filter((d) => d.type === 'CERTIFICATE').length;
      const decls = items.filter((d) => d.type === 'DECLARATION').length;
      return (
        <>
          <div style={{ fontWeight: 600, color: relevantActive ? 'var(--success)' : 'var(--warning)' }}>
            {relevantActive ? `На этот товар действует: ${relevantActive}` : 'На этот товар действующих нет'}
          </div>
          <div style={{ marginTop: 4 }}>
            Всего найдено {total}, из них действует {active}
          </div>
          <div className="t-caption muted" style={{ marginTop: 4 }}>
            {[certs && `сертификатов: ${certs}`, decls && `деклараций: ${decls}`].filter(Boolean).join(', ')}
            {' · список — в карточке'}
          </div>
        </>
      );
    },
  },
  { label: 'Риск-сигналы', render: (s) => (s.risks.length ? <span style={{ color: 'var(--danger)' }}>{s.risks.map((r) => r.title).join('; ')}</span> : 'не найдены') },
  { label: 'Дата проверки', render: (s) => <span className="num">{formatDate(s.checkedAt)}</span> },
  { label: 'Источники', render: (s) => s.sources.join(', ') + (s.isManualTestData ? ' (тестовые данные)' : '') },
];

/** Экран сравнения (ТЗ 7.4): максимум три поставщика. */
export function CompareScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 3), [params]);
  const query = useMemo(() => decodeQuery(location.search), [location.search]);
  const { removeCompare, showToast, form, lastSearchId } = useApp();
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<'offline' | 'error' | null>(null);
  const [saving, setSaving] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.compare(ids, query));
    } catch (err) {
      setError(err instanceof NetworkError ? 'offline' : 'error');
    }
  }, [ids, query]);

  useEffect(() => {
    if (ids.length) void load();
  }, [load, ids.length]);

  const remove = (id: string) => {
    removeCompare(id);
    const next = ids.filter((x) => x !== id);
    if (!next.length) {
      navigate(-1);
      return;
    }
    navigate(`/compare?ids=${next.join(',')}${query ? `&${encodeQuery(query)}` : ''}`, { replace: true });
  };

  if (!ids.length)
    return (
      <div className="screen">
        <StateView title="Нечего сравнивать" text="Добавьте 2–3 поставщика из выдачи кнопкой «Сравнить».">
          <Button block onClick={() => navigate('/')}>
            К поиску
          </Button>
        </StateView>
      </div>
    );

  if (error)
    return (
      <div className="screen">
        <StateView title={error === 'offline' ? 'Нет соединения' : 'Не удалось загрузить сравнение'} text="Попробуйте ещё раз.">
          <Button block onClick={load}>
            Повторить
          </Button>
        </StateView>
      </div>
    );

  if (!data)
    return (
      <div className="screen stack-3" aria-busy="true">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSelection({ query: query ?? { ...EMPTY_QUERY, ...form }, supplierIds: data.suppliers.map((s) => s.id), title: `Сравнение: ${data.suppliers.map((s) => s.name.replace(/^(ООО|АО|ИП)\s*/, '')).join(', ')}`.slice(0, 120) }, lastSearchId ?? undefined);
      haptic('success');
      showToast('Подборка сохранена. Открыть её можно командой /saved', { label: 'Открыть', run: () => navigate('/saved') });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen screen--with-bar">
      <h1 className="t-h1">Сравнение</h1>
      <p className="t-caption muted" style={{ margin: '4px 0 16px' }}>
        До трёх поставщиков. Только проверяемые сведения с источниками, без общего балла.
      </p>
      {data.warnings.map((w) => (
        <div key={w} style={{ marginBottom: 12 }}>
          <Notice tone={w.startsWith('Часть') ? 'warning' : 'info'}>{w}</Notice>
        </div>
      ))}
      {data.suppliers.length < 2 && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="info">Добавьте ещё хотя бы одного поставщика, чтобы было из чего выбрать.</Notice>
        </div>
      )}
      <div className="compare" role="region" aria-label="Таблица сравнения" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="row">Поле</th>
              {data.suppliers.map((s) => (
                <th key={s.id} scope="col">
                  <div className="row" style={{ alignItems: 'flex-start', gap: 0 }}>
                    <button type="button" className="btn btn--text grow break" style={{ padding: 0, justifyContent: 'flex-start', textAlign: 'left', color: 'var(--text-primary)' }} onClick={() => navigate(`/supplier/${s.id}${query ? `?${encodeQuery(query)}` : ''}`)}>
                      {softHyphens(s.name)}
                    </button>
                    <IconButton label={`Убрать ${s.name} из сравнения`} onClick={() => remove(s.id)}>
                      <X {...ICON_S} />
                    </IconButton>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{softHyphens(row.label)}</th>
                {data.suppliers.map((s) => (
                  <td key={s.id}>{row.render(s)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-caption muted" style={{ marginTop: 16 }}>
        Цена, наличие и сроки поставки не сравниваются: эти сведения не подтверждены источниками.
      </p>
      <StickyActionBar>
        <Button variant="secondary" block icon={<Send size={20} strokeWidth={2} aria-hidden />} onClick={() => setQuoteOpen(true)}>
          Запрос КП
        </Button>
        <Button block loading={saving} icon={<BookmarkPlus size={20} strokeWidth={2} aria-hidden />} onClick={save}>
          Сохранить
        </Button>
      </StickyActionBar>

      <QuoteSheet
        suppliers={quoteOpen ? data.suppliers.map((x) => ({ id: x.id, name: x.name })) : []}
        query={query ?? { ...EMPTY_QUERY, text: data.suppliers[0]?.product.titles[0] ?? '' }}
        searchId={lastSearchId}
        source="compare"
        onClose={() => setQuoteOpen(false)}
      />
    </div>
  );
}
