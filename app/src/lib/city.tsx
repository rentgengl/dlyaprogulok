import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadSetting, saveSetting } from './storage';
import type { CityChoice } from './types';

const KEY = 'city';

interface CityState {
  /** null — ещё не выбирали: приложение начинается с выбора города. */
  choice: CityChoice | null;
  ready: boolean;
  choose: (choice: CityChoice) => void;
}

const CityContext = createContext<CityState>({ choice: null, ready: false, choose: () => {} });

function parse(raw: string | null): CityChoice | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.kind === 'all') return { kind: 'all' };
    const c = v?.city;
    if (v?.kind === 'city' && typeof c?.name === 'string' && typeof c.lat === 'number' && typeof c.lng === 'number') {
      return { kind: 'city', city: { name: c.name, lat: c.lat, lng: c.lng } };
    }
  } catch {}
  return null;
}

export function CityProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<CityChoice | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadSetting(KEY).then((raw) => {
      setChoice(parse(raw));
      setReady(true);
    });
  }, []);

  const choose = useCallback((next: CityChoice) => {
    setChoice(next);
    saveSetting(KEY, JSON.stringify(next));
  }, []);

  const value = useMemo(() => ({ choice, ready, choose }), [choice, ready, choose]);
  return <CityContext.Provider value={value}>{children}</CityContext.Provider>;
}

export const useCity = () => useContext(CityContext);

export const cityName = (choice: CityChoice | null) => (choice?.kind === 'city' ? choice.city.name : 'Все города');
