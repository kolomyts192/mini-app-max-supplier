import { useEffect, useState } from 'react';
import { api } from './api/client';
import type { Overview } from './api/types';

let overviewCache: { at: number; data: Overview } | null = null;

/** Сводка по базе (дашборд, счётчики категорий). Кэш на 5 минут между экранами. */
export function useOverview(): { data: Overview | null; error: boolean; reload: () => void } {
  const [data, setData] = useState<Overview | null>(overviewCache?.data ?? null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (overviewCache && Date.now() - overviewCache.at < 300_000 && nonce === 0) {
      setData(overviewCache.data);
      return;
    }
    let alive = true;
    setError(false);
    api
      .overview()
      .then((d) => {
        overviewCache = { at: Date.now(), data: d };
        if (alive) setData(d);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [nonce]);

  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export const fmt = (n: number) => n.toLocaleString('ru-RU');
