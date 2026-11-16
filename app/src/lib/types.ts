export interface LatLng {
  lat: number;
  lng: number;
}

/** Лимит созданных маршрутов на календарный месяц (по Москве). null — без ограничения. */
export interface Quota {
  limit: number | null;
  used: number;
  remaining: number | null;
  resetsAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  /** Подтверждена ли почта; без почтового сервиса на сервере всегда true. */
  emailVerified: boolean;
  /** Доступ к админке /admin. */
  isAdmin: boolean;
  quota: Quota;
  /** Баллы: всего и доступно к трате (без резервов и заморозок). */
  wallet: { balance: number; available: number };
}

/** Направление рассказа о месте. */
export type StoryStyle = 'facts' | 'legends';

export const STORY_STYLE_LABEL: Record<StoryStyle, string> = {
  facts: 'Факты',
  legends: 'Мифы и легенды',
};

export interface RouteSummary {
  id: string;
  /** Цена в баллах; null — бесплатный маршрут. */
  price?: number | null;
  /** Маршрут открыт этим пользователем или это его маршрут. */
  owned?: boolean;
  /** Платный маршрут без доступа: только превью, без точек и карты. */
  locked?: boolean;
  title: string;
  description: string;
  lang: string;
  isPublic: boolean;
  roundTrip: boolean;
  start: LatLng & { label: string | null };
  distanceM: number;
  durationMin: number;
  planner: 'ai' | 'heuristic' | 'manual';
  city: string | null;
  /** Направление рассказов по умолчанию. */
  storyStyle: StoryStyle;
  /** Свой финиш; null — у старта (roundTrip) или на последней точке. */
  finish: (LatLng & { label: string | null }) | null;
  ownerId: string;
  ownerName: string;
  pointCount: number;
  rating: { avg: number | null; count: number };
  createdAt: string;
}

export interface Media {
  id: string;
  kind: 'image' | 'audio' | 'video';
  url: string;
  mime: string;
  size: number;
  caption: string;
}

/** ai_facts и facts — для мест без статьи: по справке Викиданных и реестра наследия. */
export type StorySource = 'ai' | 'ai_sourced' | 'ai_facts' | 'wikipedia' | 'facts' | 'author';

/** Фото места с Wikimedia Commons: автор и лицензия обязательны к показу. */
export interface PlacePhoto {
  url: string;
  width?: number;
  height?: number;
  page: string;
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
}

export interface RoutePoint extends LatLng {
  id: string;
  position: number;
  name: string;
  kind: string | null;
  teaser: string;
  story: string | null;
  storySource: StorySource | null;
  storySourceUrl: string | null;
  /** null — текст автора. */
  storyStyle: StoryStyle | null;
  narrationUrl: string | null;
  media: Media[];
  photo: PlacePhoto | null;
  wikidata: string | null;
  /** Номер в реестре объектов культурного наследия (ЕГРОКН). */
  heritageRef: string | null;
}

export interface Route extends RouteSummary {
  geometry: [number, number][];
  myRating: number | null;
  isOwner: boolean;
  /** Автор или администратор: показывать инструменты правки. */
  canEdit: boolean;
  /** Фоновая задача по маршруту (только для автора): идущая или закончившаяся недавно. */
  job: Job | null;
  points: RoutePoint[];
}

export interface GeocodeResult extends LatLng {
  name: string;
}

export interface UploadAsset {
  uri: string;
  name: string;
  mimeType: string;
  /** На вебе пикер отдаёт настоящий File; на телефонах достаточно uri. */
  file?: File;
}

/** Место рядом с маршрутом, которое можно добавить одним нажатием. */
export interface Suggestion extends LatLng {
  name: string;
  kind: string;
  wikiTitle: string | null;
  wikidata: string | null;
  heritageRef: string | null;
  about: string | null;
  /** До ближайшей точки маршрута. */
  distanceM: number;
}

export interface City extends LatLng {
  name: string;
}

/** Город с открытыми экскурсиями. */
export interface CityWithCount extends City {
  count: number;
}

export interface CitySearchResult extends City {
  region: string;
}

/** Выбор на первом экране: конкретный город или все сразу. */
export type CityChoice = { kind: 'city'; city: City } | { kind: 'all' };

export type ExportFormat = 'gpx' | 'kml';

/** Фоновая задача на сервере: подбор маршрута или рассказы для его точек. */
export interface Job {
  id: string;
  kind: 'generate' | 'stories';
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: 'planning' | 'stories' | null;
  routeId: string | null;
  done: number;
  total: number;
  failed: number;
  notices: string[];
  error: string | null;
  params: { request?: { start?: { label?: string } }; autoStories?: boolean };
  createdAt: string;
  updatedAt: string;
}

// ---------- Монетизация ----------

export interface Pricing {
  route3h: number;
  story: number;
  narration2min: number;
  saleCommissionPct: number;
  payoutCommissionPct: number;
  routePrice: { min: number; max: number };
  tip: { min: number; max: number };
  topup: { min: number; max: number };
  payoutMin: number;
  /** false — платежи не подключены: цен и покупок в приложении нет. */
  paymentsEnabled: boolean;
}

export type PayoutStatus = 'open' | 'paid' | 'rejected';

export interface PayoutRequest {
  id: string;
  points: number;
  feePct: number;
  payoutRub: number;
  status: PayoutStatus;
  createdAt: string;
  note?: string | null;
  decidedAt?: string | null;
}

export interface Wallet {
  balance: number;
  available: number;
  /** Заморожено заявкой на вывод или возвратом. */
  frozen: number;
  /** Зарезервировано под идущую генерацию. */
  reserved: number;
  pendingPayout: PayoutRequest | null;
  incomeThisMonth: number;
}

export type LedgerKind = 'topup' | 'charge' | 'route_purchase' | 'tip' | 'payout' | 'refund';

export interface LedgerItem {
  id: number;
  kind: LedgerKind;
  amount: number;
  createdAt: string;
  title: string;
  route: { id: string; title: string } | null;
  counterparty: { id: string; name: string } | null;
  commission: number | null;
  message: string | null;
}

export type PaymentStatus = 'created' | 'pending' | 'succeeded' | 'canceled' | 'mismatch';

export interface Payment {
  id: string;
  status: PaymentStatus;
  points: number;
  createdAt: string;
  confirmationUrl?: string | null;
  cancelReason?: string | null;
}

/** Статус проверки платного маршрута. */
export type SaleStatus = 'pending' | 'approved' | 'rejected' | 'delisted';

/** Цена платного действия до подтверждения; free — входит в бесплатный лимит. */
export interface Quote {
  cost: number;
  free?: boolean;
  freeLeft?: number | null;
  limit?: number | null;
}
