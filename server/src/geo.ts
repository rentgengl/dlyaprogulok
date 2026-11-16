export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
/** Прямая на карте короче реального пешего пути примерно на столько. */
export const WALK_DETOUR_FACTOR = 1.3;
export const WALK_METERS_PER_MIN = 75; // 4,5 км/ч
export const STOP_MINUTES = 8;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Длина ломаной start → stops, дальше к финишу: к старту, если маршрут кольцевой,
 * к своей точке end, если она задана, иначе прогулка кончается на последней остановке.
 */
export function pathLength(start: LatLng, stops: LatLng[], roundTrip: boolean, end?: LatLng | null): number {
  let total = 0;
  let prev = start;
  for (const s of stops) {
    total += haversine(prev, s);
    prev = s;
  }
  if (end) total += haversine(prev, end);
  else if (roundTrip && stops.length > 0) total += haversine(prev, start);
  return total;
}

/** Порядок обхода: ближайший сосед, затем 2-opt. Убирает петли и зигзаги. */
export function orderStops<T extends LatLng>(start: LatLng, stops: T[], roundTrip: boolean, end?: LatLng | null): T[] {
  const left = [...stops];
  const order: T[] = [];
  let cur = start;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((s, i) => {
      const d = haversine(cur, s);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    order.push(next!);
    cur = next!;
  }
  return twoOpt(start, order, roundTrip, end);
}

function twoOpt<T extends LatLng>(start: LatLng, stops: T[], roundTrip: boolean, end?: LatLng | null): T[] {
  let best = stops;
  let bestLen = pathLength(start, best, roundTrip, end);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const len = pathLength(start, candidate, roundTrip, end);
        if (len < bestLen - 1) {
          best = candidate;
          bestLen = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

export interface Budget {
  /** Пешая часть маршрута, метры. */
  walkMeters: number;
  /** Максимум остановок, чтобы уложиться в заявленную длительность. */
  maxStops: number;
  /** Радиус поиска вокруг старта. */
  searchRadius: number;
  /** Предел по времени вместе с остановками, если пользователь задал длительность. */
  maxMinutes?: number;
}

export type RouteTarget = { durationMin: number } | { distanceM: number };

/** Средняя цена остановки с дорогой до неё: потолок числа точек для заданного времени. */
const MINUTES_PER_STOP_WITH_WALK = 11;
/** Доля времени на ходьбу: остальное уходит на рассказы, это прогулка, а не марш-бросок. */
const WALK_TIME_SHARE = 0.6;

/** Переводит пожелание пользователя в пеший бюджет. */
export function computeBudget(target: RouteTarget, roundTrip: boolean): Budget {
  let walkMeters: number;
  let maxStops: number;
  let maxMinutes: number | undefined;
  if ('durationMin' in target) {
    maxMinutes = target.durationMin;
    walkMeters = target.durationMin * WALK_TIME_SHARE * WALK_METERS_PER_MIN;
    maxStops = Math.max(2, Math.floor(target.durationMin / MINUTES_PER_STOP_WITH_WALK));
  } else {
    walkMeters = target.distanceM;
    maxStops = Math.max(2, Math.round(target.distanceM / 450));
  }
  maxStops = Math.min(maxStops, 15);
  const reach = roundTrip ? walkMeters / 2.4 : walkMeters / 1.3;
  return { walkMeters, maxStops, searchRadius: Math.round(clamp(reach, 400, 5000)), maxMinutes };
}

export function estimateDurationMin(walkMeters: number, stops: number): number {
  return Math.round(walkMeters / WALK_METERS_PER_MIN + stops * STOP_MINUTES);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Куда вставить новую точку, чтобы прогулка удлинилась меньше всего. */
export function bestInsertion(
  start: LatLng,
  stops: LatLng[],
  added: LatLng,
  roundTrip: boolean,
  end?: LatLng | null,
): number {
  let best = stops.length;
  let bestLen = Infinity;
  for (let i = 0; i <= stops.length; i++) {
    const len = pathLength(start, [...stops.slice(0, i), added, ...stops.slice(i)], roundTrip, end);
    if (len < bestLen - 0.01) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

/** Средняя точка: от неё ищутся места рядом с уже собранным маршрутом. */
export function centroid(points: LatLng[]): LatLng {
  const n = Math.max(points.length, 1);
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lng: points.reduce((s, p) => s + p.lng, 0) / n,
  };
}
