import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setApiToken } from './api';
import { clearToken, loadToken, saveToken } from './storage';
import type { User } from './types';

interface AuthState {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  /** true — письмо с подтверждением отправлено. */
  signUp: (name: string, email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  /** Перечитать профиль: после подтверждения почты или создания маршрута (лимит). */
  refresh: () => Promise<void>;
  /** Профиль, который сервер уже вернул в ответе. */
  setUser: (user: User) => void;
  /** Вход по готовой сессии: после сброса пароля. */
  adopt: (res: { token: string; user: User }) => Promise<void>;
  /** Забыть сессию на устройстве без запроса к серверу: после удаления аккаунта. */
  forget: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await loadToken();
      if (token) {
        setApiToken(token);
        try {
          setUser((await api.me()).user);
        } catch (err) {
          // Без связи сессию не трогаем: сбрасываем, только если сервер её отверг.
          if (err instanceof ApiError && err.status === 401) {
            setApiToken(null);
            await clearToken();
          }
        }
      }
      setReady(true);
    })();
  }, []);

  const accept = useCallback(async (res: { token: string; user: User }) => {
    setApiToken(res.token);
    await saveToken(res.token);
    setUser(res.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      signIn: async (email, password) => accept(await api.login(email, password)),
      signUp: async (name, email, password) => {
        const res = await api.register(name, email, password);
        await accept(res);
        return res.mailSent;
      },
      refresh: async () => {
        if (!user) return;
        try {
          setUser((await api.me()).user);
        } catch {
          // Профиль обновится при следующем запуске.
        }
      },
      setUser,
      adopt: accept,
      forget: async () => {
        setApiToken(null);
        await clearToken();
        setUser(null);
      },
      signOut: async () => {
        await api.logout().catch(() => {});
        setApiToken(null);
        await clearToken();
        setUser(null);
      },
    }),
    [user, ready, accept],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вне AuthProvider');
  return ctx;
}
