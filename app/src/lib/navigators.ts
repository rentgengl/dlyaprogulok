import type { LatLng, Route } from './types';

const c = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Порядок обхода: старт, точки и финиш (снова старт, своё место или последняя точка). */
function stops(route: Route): LatLng[] {
  const pts = [route.start, ...route.points];
  if (route.finish) return [...pts, route.finish];
  return route.roundTrip ? [...pts, route.start] : pts;
}

/** Яндекс Карты строят пеший маршрут (rtt=pd) через все точки. */
export function yandexMapsUrl(route: Route): string {
  return `https://yandex.ru/maps/?rtext=${stops(route).map(c).join('~')}&rtt=pd`;
}

/** Google Карты принимают не больше 9 промежуточных точек. */
export const GOOGLE_MAX_WAYPOINTS = 9;

export function googleMapsUrl(route: Route): { url: string; truncated: boolean } {
  const all = stops(route);
  const origin = all[0]!;
  const destination = all[all.length - 1]!;
  const middle = all.slice(1, -1);
  const qs = new URLSearchParams({
    api: '1',
    origin: c(origin),
    destination: c(destination),
    travelmode: 'walking',
  });
  if (middle.length) qs.set('waypoints', middle.slice(0, GOOGLE_MAX_WAYPOINTS).map(c).join('|'));
  return { url: `https://www.google.com/maps/dir/?${qs}`, truncated: middle.length > GOOGLE_MAX_WAYPOINTS };
}
