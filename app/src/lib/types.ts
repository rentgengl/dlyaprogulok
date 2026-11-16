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
}

/** Направление рассказа о месте. */
export type StoryStyle = 'facts' | 'legends';

export const STORY_STYLE_LABEL: Record<StoryStyle, string> = {
  facts: 'Факты',
  legends: 'Мифы и легенды',
};

export interface RouteSummary {
  id: string;
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
