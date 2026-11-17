import { adminRequest } from './api';
import type { Quota, Route, RouteSummary, SaleStatus, StoryStyle } from './types';

export interface AdminStats {
  users: { total: number; verified: number; blocked: number; admins: number; newThisMonth: number };
  routes: { total: number; public: number; generatedThisMonth: number };
  points: { total: number; withStory: number; narrated: number };
  media: { files: number; bytes: number };
  services: ServicesStatus;
  monthStart: string;
}

export interface ServicesStatus {
  ai: { provider: string | null; model: string | null };
  tts: string | null;
  mailer: string | null;
  routeMonthlyLimit: number;
  appUrl: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  blocked: boolean;
  blockedAt: string | null;
  emailVerified: boolean;
  /** null — общий лимит, 0 — без ограничения. */
  routeLimit: number | null;
  routeCount: number;
  usedThisMonth: number;
  createdAt: string;
  activeSessions: number;
  quota?: Quota;
}

export type AdminRoute = RouteSummary & { ownerEmail: string; updatedAt: string };

export interface Setting {
  key: string;
  label: string;
  group: string;
  kind: 'text' | 'secret' | 'number' | 'select';
  options?: string[];
  help?: string;
  editable: boolean;
  source: 'admin' | 'env' | 'default';
  /** Для секретов всегда null: сервер их не отдаёт. */
  value: string | null;
  isSet: boolean;
  masked: string | null;
  envValue: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type UserPatch = Partial<{
  name: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  blocked: boolean;
  routeLimit: number | null;
  password: string;
}>;

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

const body = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

export const adminApi = {
  stats: () => adminRequest<AdminStats>('/api/admin/stats'),

  users: (p: { q?: string; filter?: string; offset?: number; limit?: number }) =>
    adminRequest<{ total: number; users: AdminUser[] }>(`/api/admin/users?${qs(p)}`),
  user: (id: string) => adminRequest<{ user: AdminUser; routes: RouteSummary[] }>(`/api/admin/users/${id}`),
  updateUser: (id: string, patch: UserPatch) => adminRequest<{ user: AdminUser }>(`/api/admin/users/${id}`, body('PATCH', patch)),
  resetQuota: (id: string) => adminRequest<{ user: AdminUser }>(`/api/admin/users/${id}/quota-reset`, { method: 'POST' }),
  logoutUser: (id: string) => adminRequest<{ closed: number }>(`/api/admin/users/${id}/logout`, { method: 'POST' }),
  deleteUser: (id: string) => adminRequest<void>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  /** Очередь проверки платных маршрутов: с полным содержимым. */
  paidRoutes: (status: SaleStatus = 'pending') => adminRequest<{ routes: Route[] }>(`/api/admin/paid-routes?status=${status}`),
  saleDecision: (id: string, decision: 'approve' | 'reject' | 'delist', note?: string) =>
    adminRequest<{ route: Route }>(`/api/admin/paid-routes/${id}/decision`, body('POST', { decision, note })),
  routes: (p: { q?: string; owner?: string; visibility?: string; sort?: string; offset?: number; limit?: number }) =>
    adminRequest<{ total: number; routes: AdminRoute[] }>(`/api/admin/routes?${qs(p)}`),
  updateRoute: (
    id: string,
    patch: Partial<{ title: string; description: string; isPublic: boolean; storyStyle: StoryStyle; city: string; owner: string }>,
  ) => adminRequest<{ route: AdminRoute }>(`/api/admin/routes/${id}`, body('PATCH', patch)),
  deleteRoute: (id: string) => adminRequest<void>(`/api/routes/${id}`, { method: 'DELETE' }),

  settings: () => adminRequest<{ settings: Setting[]; services: ServicesStatus }>('/api/admin/settings'),
  saveSettings: (values: Record<string, string | null>) =>
    adminRequest<{ settings: Setting[]; services: ServicesStatus }>('/api/admin/settings', body('PUT', { values })),
  testMail: () => adminRequest<{ sentTo: string }>('/api/admin/settings/test-mail', { method: 'POST' }),
};
