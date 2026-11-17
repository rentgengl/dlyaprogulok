import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type {
  CitySearchResult,
  CityWithCount,
  City,
  ExportFormat,
  StoryStyle,
  GeocodeResult,
  Job,
  LatLng,
  LedgerItem,
  Payment,
  Pricing,
  Quote,
  StoriesQuote,
  PointStoryQuote,
  Wallet,
  Quota,
  Route,
  RouteSummary,
  Suggestion,
  UploadAsset,
  User,
} from './types';

function resolveBaseUrl(): string {
  // Сайт обслуживает API с того же адреса: сборка работает и по домену, и по IP сервера.
  if (Platform.OS === 'web' && !__DEV__ && globalThis.location?.origin) return globalThis.location.origin;
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  if (Platform.OS === 'web') return `http://${globalThis.location?.hostname ?? 'localhost'}:3000`;
  // В разработке сервер запущен на той же машине, что и Metro.
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:3000`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
}

export const API_URL = resolveBaseUrl();
/** Маршрутов на странице списка; на карте — до CATALOG_MAP_LIMIT сразу. */
export const CATALOG_PAGE = 20;
export const CATALOG_MAP_LIMIT = 500;
export const MAP_URL = `${API_URL}/map/index.html`;
export const mediaUrl = (path: string) => `${API_URL}${path}`;

let token: string | null = null;
export const setApiToken = (t: string | null) => {
  token = t;
};

/** Ошибка API. code и body — для платных действий: INSUFFICIENT_POINTS { need, available }, PRICE_CHANGED { cost }. */
export class ApiError extends Error {
  status: number;
  code?: string;
  body: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Что-то пошло не так', data?.code, data ?? {});
  return data as T;
}

/** Запросы админки: тот же токен и обработка ошибок. */
export const adminRequest = request;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body ?? {}),
});

type RouteResponse = { route: Route; notices?: string[] };

export const api = {
  register: (name: string, email: string, password: string) =>
    request<{ token: string; user: User; mailSent: boolean }>('/api/auth/register', json('POST', { name, email, password })),
  /** Ссылка из письма; user — только если открыта там, где выполнен вход. */
  verifyEmail: (token: string) => request<{ verified: true; user: User | null }>('/api/auth/verify', json('POST', { token })),
  resendVerification: () => request<{ sent: boolean; user: User }>('/api/auth/resend', { method: 'POST' }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/api/auth/login', json('POST', { email, password })),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  /** Письмо со ссылкой сброса; ответ одинаковый для любого адреса. */
  forgotPassword: (email: string) => request<{ sent: true }>('/api/auth/forgot', json('POST', { email })),
  resetPassword: (token: string, password: string) =>
    request<{ token: string; user: User }>('/api/auth/reset', json('POST', { token, password })),
  deleteAccount: (password: string) => request<void>('/api/me', json('DELETE', { password })),
  me: () => request<{ user: User }>('/api/me'),
  /** Что включено на сервере: ИИ, синтез речи, подтверждение почты. */
  config: () => request<{ aiEnabled: boolean; ttsEnabled: boolean; emailVerification: boolean }>('/api/config'),

  geocode: (q: string, near?: LatLng) => {
    const qs = new URLSearchParams({ q });
    if (near) {
      qs.set('lat', String(near.lat));
      qs.set('lng', String(near.lng));
    }
    return request<{ results: GeocodeResult[] }>(`/api/geocode?${qs}`);
  },

  cities: () => request<{ cities: CityWithCount[] }>('/api/cities'),
  searchCities: (q: string) => request<{ cities: CitySearchResult[] }>(`/api/cities/search?q=${encodeURIComponent(q)}`),
  locateCity: (p: LatLng) => request<{ city: City }>(`/api/cities/locate?lat=${p.lat}&lng=${p.lng}`),

  catalog: (params: {
    sort: 'rating' | 'new';
    q?: string;
    city?: string;
    lat?: number;
    lng?: number;
    offset?: number;
    limit?: number;
  }) => {
    const qs = new URLSearchParams({
      sort: params.sort,
      limit: String(params.limit ?? CATALOG_PAGE),
      offset: String(params.offset ?? 0),
    });
    if (params.q) qs.set('q', params.q);
    if (params.city) qs.set('city', params.city);
    if (params.lat !== undefined && params.lng !== undefined) {
      qs.set('lat', String(params.lat));
      qs.set('lng', String(params.lng));
    }
    return request<{ routes: RouteSummary[] }>(`/api/routes?${qs}`);
  },
  mine: () => request<{ routes: RouteSummary[] }>('/api/routes/mine'),
  route: (id: string) => request<RouteResponse>(`/api/routes/${id}`),
  /** Подбор в фоне: сервер сразу отвечает задачей, маршрут появится в ней (routeId). */
  generateInBackground: (body: {
    start: { lat: number; lng: number; label?: string };
    durationMin?: number;
    distanceM?: number;
    roundTrip: boolean;
    interests?: string;
    storyStyle?: StoryStyle;
    autoStories: boolean;
    /** Подтверждённая цена; нужна, если маршрут сверх бесплатного лимита. */
    expectedCost?: number;
  }) => request<{ job: Job; quota: Quota }>('/api/routes/generate', json('POST', { ...body, background: true })),
  job: (id: string) => request<{ job: Job }>(`/api/jobs/${id}`),
  jobs: () => request<{ jobs: Job[] }>('/api/jobs'),
  /** Рассказы для всех точек в фоне; если задача уже идёт, вернётся она. */
  routeStories: (id: string, body: { style?: StoryStyle; redo?: boolean; expectedCost?: number }) =>
    request<{ job: Job; cost: number }>(`/api/routes/${id}/stories`, json('POST', body)),
  /** Маршрут вручную: пустой, точки добавляет автор. Месячный лимит не тратит. */
  createRoute: (body: {
    title: string;
    description?: string;
    start: { lat: number; lng: number; label?: string };
    roundTrip: boolean;
    storyStyle?: StoryStyle;
  }) => request<{ route: Route }>('/api/routes', json('POST', body)),
  generate: (body: {
    start: { lat: number; lng: number; label?: string };
    durationMin?: number;
    distanceM?: number;
    roundTrip: boolean;
    interests?: string;
    storyStyle?: StoryStyle;
    expectedCost?: number;
  }) => request<RouteResponse & { quota: Quota }>('/api/routes/generate', json('POST', body)),
  updateRoute: (id: string, patch: { title?: string; description?: string; isPublic?: boolean; storyStyle?: StoryStyle }) =>
    request<RouteResponse>(`/api/routes/${id}`, json('PATCH', patch)),
  deleteRoute: (id: string) => request<void>(`/api/routes/${id}`, { method: 'DELETE' }),
  updateEndpoints: (
    routeId: string,
    body: {
      start?: LatLng & { label?: string };
      finish?: { type: 'start' } | { type: 'last' } | ({ type: 'point'; label?: string } & LatLng);
    },
  ) => request<RouteResponse>(`/api/routes/${routeId}/endpoints`, json('PATCH', body)),
  addPoint: (
    routeId: string,
    place: LatLng & {
      name: string;
      teaser?: string;
      kind?: string;
      wikiTitle?: string;
      wikidata?: string;
      heritageRef?: string;
      position?: number;
    },
  ) => request<RouteResponse & { pointId: string }>(`/api/routes/${routeId}/points`, json('POST', place)),
  reorder: (routeId: string, order: { pointIds: string[] } | { auto: true }) =>
    request<RouteResponse>(`/api/routes/${routeId}/order`, json('PUT', order)),
  suggestions: (routeId: string) => request<{ suggestions: Suggestion[] }>(`/api/routes/${routeId}/suggestions`),
  /** Файл для навигатора: текст и имя, под которым его сохранить. */
  exportRoute: async (routeId: string, format: ExportFormat) => {
    const res = await send(`/api/routes/${routeId}/export?format=${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, data?.error ?? 'Не удалось подготовить файл');
    }
    return { text: await res.text(), fileName: fileNameFrom(res.headers.get('content-disposition'), format) };
  },
  rate: (id: string, value: number) => request<RouteResponse>(`/api/routes/${id}/rating`, json('PUT', { value })),

  updatePoint: (id: string, patch: { name?: string; teaser?: string; story?: string }) =>
    request<RouteResponse>(`/api/points/${id}`, json('PATCH', patch)),
  deletePoint: (id: string) => request<RouteResponse>(`/api/points/${id}`, { method: 'DELETE' }),
  /** fresh — «Создать заново»: новый текст вместо готового рассказа о том же месте из другого маршрута. */
  generateStory: (id: string, opts: { keepText?: boolean; style?: StoryStyle; fresh?: boolean; expectedCost?: number } = {}) =>
    request<RouteResponse & { reused?: boolean; charged?: number }>(`/api/points/${id}/story`, json('POST', opts)),
  deleteMedia: (id: string) => request<RouteResponse>(`/api/media/${id}`, { method: 'DELETE' }),

  // ---------- Платные маршруты ----------
  /** Цена в баллах — заявка на проверку; null — маршрут снова бесплатный. */
  setRoutePrice: (id: string, price: number | null) => request<RouteResponse>(`/api/routes/${id}/price`, json('PUT', { price })),
  purchaseRoute: (id: string, expectedCost: number) =>
    request<RouteResponse>(`/api/routes/${id}/purchase`, json('POST', { expectedCost })),

  // ---------- Баллы ----------
  pricing: () => request<Pricing>('/api/pricing'),
  wallet: () => request<Wallet>('/api/wallet'),
  walletHistory: (before?: number) =>
    request<{ items: LedgerItem[]; next: number | null }>(`/api/wallet/history${before ? `?before=${before}` : ''}`),
  createPayment: (points: number) => request<{ payment: Payment }>('/api/payments', json('POST', { points })),
  getPayment: (id: string) => request<{ payment: Payment }>(`/api/payments/${id}`),
  /** Только подставной шлюз разработки: имитация оплаты или отказа покупателя. */
  fakePay: (id: string, result: 'succeeded' | 'canceled') =>
    request<{ payment: Payment }>(`/api/dev/fake-payments/${id}`, json('POST', { result })),
  routeQuote: (p: { durationMin?: number; distanceM?: number; roundTrip: boolean }) => {
    const qs = new URLSearchParams({ roundTrip: String(p.roundTrip) });
    if (p.durationMin !== undefined) qs.set('durationMin', String(p.durationMin));
    if (p.distanceM !== undefined) qs.set('distanceM', String(p.distanceM));
    return request<Quote & { free: boolean; paymentsEnabled: boolean }>(`/api/routes/quote?${qs}`);
  },
  storiesQuote: (routeId: string, p: { style?: StoryStyle; redo?: boolean } = {}) => {
    const qs = new URLSearchParams({ redo: String(!!p.redo) });
    if (p.style) qs.set('style', p.style);
    return request<StoriesQuote>(`/api/routes/${routeId}/stories/quote?${qs}`);
  },
  pointStoryQuote: (pointId: string, keepText = false) =>
    request<PointStoryQuote>(`/api/points/${pointId}/story/quote?keepText=${keepText}`),

  uploadMedia: (pointId: string, asset: UploadAsset) => {
    const form = new FormData();
    if (asset.file) form.append('file', asset.file, asset.name);
    else form.append('file', { uri: asset.uri, name: asset.name, type: asset.mimeType } as unknown as Blob);
    return request<RouteResponse>(`/api/points/${pointId}/media`, { method: 'POST', body: form });
  },
};

/** Имя из filename* (UTF-8), иначе из filename, иначе общее. */
function fileNameFrom(header: string | null, ext: string): string {
  const utf = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf) {
    try {
      return decodeURIComponent(utf);
    } catch {}
  }
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? `route.${ext}`;
}
