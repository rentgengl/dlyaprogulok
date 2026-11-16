import type { StyleProp, ViewStyle } from 'react-native';
import type { LatLng } from '@/lib/types';

export interface RouteMapProps {
  start?: LatLng | null;
  points?: (LatLng & { id: string; name: string })[];
  geometry?: [number, number][];
  selectedId?: string | null;
  /** Куда смотреть, пока на карте ничего нет: например, выбранный город. */
  center?: LatLng | null;
  /** Свой финиш, если он не у старта и не на последней точке. */
  finish?: LatLng | null;
  /** Место, которое пользователь собирается добавить. */
  draft?: LatLng | null;
  /** Старты маршрутов для вида каталога на карте; близкие собираются в группы. */
  starts?: (LatLng & { id: string; title: string })[];
  /** Маршруты, чьи старты выделены. */
  selectedStarts?: string[];
  /** Новый ключ — вид подгоняется заново. */
  fitKey?: string;
  onPress?: (p: LatLng) => void;
  onMarkerPress?: (id: string) => void;
  /** Нажали на старт маршрута или на группу, которую уже не разделить приближением. */
  onRoutesPress?: (ids: string[]) => void;
  style?: StyleProp<ViewStyle>;
}

export type MapMessage =
  | { type: 'ready' }
  | { type: 'press'; lat: number; lng: number }
  | { type: 'marker'; id: string }
  | { type: 'routes'; ids: string[] };

export function mapState(p: RouteMapProps) {
  return {
    start: p.start ?? null,
    points: (p.points ?? []).map(({ id, name, lat, lng }) => ({ id, name, lat, lng })),
    geometry: p.geometry ?? [],
    selectedId: p.selectedId ?? null,
    center: p.center ? { lat: p.center.lat, lng: p.center.lng } : null,
    draft: p.draft ? { lat: p.draft.lat, lng: p.draft.lng } : null,
    finish: p.finish ? { lat: p.finish.lat, lng: p.finish.lng } : null,
    starts: (p.starts ?? []).map(({ id, title, lat, lng }) => ({ id, title, lat, lng })),
    selectedStarts: p.selectedStarts ?? [],
    fitKey: p.fitKey,
  };
}

export function parseMapMessage(data: string): MapMessage | null {
  try {
    return JSON.parse(data) as MapMessage;
  } catch {
    return null;
  }
}
