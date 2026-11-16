import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { pluralRoutes } from '@/lib/format';
import { loadSetting, saveSetting } from '@/lib/storage';
import { colors, CONTENT_MAX_WIDTH, radius, serif, space } from '@/lib/theme';
import type { LatLng, RouteSummary } from '@/lib/types';
import { RouteCard } from './RouteCard';
import { RouteMap } from './RouteMap';

/**
 * Список маршрутов на карте: каждый маршрут — значок в точке старта, близкие старты
 * собираются в группу с числом. Нажатие на старт или на неразделимую группу
 * открывает снизу карточки этих маршрутов.
 */
export function RoutesMap({
  routes,
  center,
  showVisibility,
}: {
  routes: RouteSummary[];
  /** Куда смотреть, если маршрутов нет. */
  center?: LatLng | null;
  showVisibility?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  // Новые данные (фильтр, поиск) — прежний выбор больше не к месту.
  const dataKey = routes.map((r) => r.id).join(',');
  const [shownKey, setShownKey] = useState(dataKey);
  if (shownKey !== dataKey) {
    setShownKey(dataKey);
    setSelected([]);
  }

  const starts = useMemo(
    () =>
      routes.map((r) => ({
        id: r.id,
        title: r.title,
        lat: r.start.lat,
        lng: r.start.lng,
      })),
    [routes],
  );
  const picked = useMemo(() => routes.filter((r) => selected.includes(r.id)), [routes, selected]);
  const place = picked.length > 1 ? commonLabel(picked) : null;

  return (
    <View style={styles.box}>
      <RouteMap
        starts={starts}
        selectedStarts={selected}
        center={center}
        fitKey={`routes:${dataKey}`}
        onRoutesPress={setSelected}
        onPress={() => setSelected([])}
      />
      {picked.length ? (
        <View style={styles.sheetWrap} pointerEvents="box-none">
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {picked.length > 1 ? `${pluralRoutes(picked.length)} отсюда` : 'Старт маршрута'}
                {place ? ` · ${place}` : ''}
              </Text>
              <Pressable
                role="button"
                aria-label="Закрыть"
                hitSlop={12}
                onPress={() => setSelected([])}
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ gap: space.md }} style={{ flexGrow: 0 }}>
              {picked.map((r) => (
                <RouteCard key={r.id} route={r} showVisibility={showVisibility} />
              ))}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Подпись места старта, если она одна у всей группы. */
function commonLabel(routes: RouteSummary[]): string | null {
  const label = routes[0].start.label;
  return label && routes.every((r) => r.start.label === label) ? label : null;
}

const styles = StyleSheet.create({
  box: { flex: 1, minHeight: 320 },
  sheetWrap: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    maxHeight: '60%',
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    flexShrink: 1,
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sheetTitle: {
    flex: 1,
    fontFamily: serif,
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
});

export type RoutesView = 'list' | 'map';

/** Переключатель «Список / Карта»; выбор запоминается между запусками. */
export function useRoutesView(): [RoutesView, (v: RoutesView) => void] {
  const [view, setView] = useState<RoutesView>('list');
  useEffect(() => {
    loadSetting(VIEW_KEY).then((v) => {
      if (v === 'map' || v === 'list') setView(v);
    });
  }, []);
  const choose = useCallback((v: RoutesView) => {
    setView(v);
    saveSetting(VIEW_KEY, v);
  }, []);
  return [view, choose];
}

const VIEW_KEY = 'routesView';

export function ViewToggle({ view, onChange }: { view: RoutesView; onChange: (v: RoutesView) => void }) {
  return (
    <View style={toggle.box} role="tablist">
      {(
        [
          ['list', 'Список', 'list-outline'],
          ['map', 'Карта', 'map-outline'],
        ] as const
      ).map(([value, label, icon]) => {
        const active = view === value;
        return (
          <Pressable
            key={value}
            role="tab"
            aria-selected={active}
            onPress={() => onChange(value)}
            style={[toggle.item, active && toggle.active]}
          >
            <Ionicons name={icon} size={16} color={active ? colors.white : colors.forest} />
            <Text style={[toggle.text, active && { color: colors.white }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const toggle = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 3,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    minHeight: 36,
    borderRadius: radius.pill,
  },
  active: { backgroundColor: colors.forest },
  text: { fontSize: 14, fontWeight: '600', color: colors.forest },
});
