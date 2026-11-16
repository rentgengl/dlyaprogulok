import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { RouteCard } from '@/components/RouteCard';
import { RoutesMap, useRoutesView, ViewToggle } from '@/components/RoutesMap';
import { Banner, Button, Chip, Empty, Field, layout } from '@/components/ui';
import { api, ApiError, CATALOG_MAP_LIMIT, CATALOG_PAGE } from '@/lib/api';
import { cityName, useCity } from '@/lib/city';
import { colors, CONTENT_MAX_WIDTH, radius, serif, space } from '@/lib/theme';
import type { LatLng, RouteSummary } from '@/lib/types';

type Mode = 'rating' | 'new' | 'near';

export default function CatalogScreen() {
  const { choice } = useCity();
  // «Рядом» ищет вокруг пользователя, город при этом не важен.
  const city = choice?.kind === 'city' ? choice.city.name : undefined;
  const [mode, setMode] = useState<Mode>('rating');
  const [view, setView] = useRoutesView();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [here, setHere] = useState<LatLng | null>(null);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const coords = mode === 'near' && here ? { lat: here.lat, lng: here.lng } : {};
        const { routes: page } = await api.catalog({
          sort: mode === 'new' ? 'new' : 'rating',
          q: debounced || undefined,
          city: mode === 'near' ? undefined : city,
          offset,
          // На карте нужны все старты сразу: группы с числом теряют смысл на неполных данных.
          limit: view === 'map' ? CATALOG_MAP_LIMIT : CATALOG_PAGE,
          ...coords,
        });
        if (id !== requestId.current) return; // пришёл ответ на устаревший запрос
        setRoutes((prev) => (offset === 0 ? page : [...prev, ...page]));
        setHasMore(view === 'list' && page.length === CATALOG_PAGE);
      } catch (err) {
        if (id === requestId.current) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [mode, here, debounced, city, view],
  );

  useFocusEffect(
    useCallback(() => {
      if (mode === 'near' && !here) return;
      load(0);
    }, [load, mode, here]),
  );

  const chooseNear = async () => {
    setMode('near');
    if (here) return;
    setLoading(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error('Разрешите доступ к геолокации, чтобы искать экскурсии рядом');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось определить местоположение');
      setRoutes([]);
      setLoading(false);
    }
  };

  const header = (
    <View style={{ gap: space.md }}>
      <Pressable
        role="button"
        aria-label={`Город: ${cityName(choice)}. Сменить`}
        onPress={() => router.push('/city')}
        style={({ pressed }) => [styles.city, pressed && { opacity: 0.7 }]}
      >
        <Ionicons name="location" size={20} color={colors.accent} />
        <Text style={styles.cityName} numberOfLines={1}>
          {cityName(choice)}
        </Text>
        <Text style={styles.cityChange}>Сменить</Text>
      </Pressable>
      <Field
        placeholder="Поиск по названию или городу"
        value={query}
        onChangeText={setQuery}
        aria-label="Поиск экскурсий"
        returnKeyType="search"
      />
      <View style={styles.filters}>
        <View style={layout.row}>
          <Chip label="Лучшие" active={mode === 'rating'} onPress={() => setMode('rating')} />
          <Chip label="Новые" active={mode === 'new'} onPress={() => setMode('new')} />
          <Chip label="Рядом" active={mode === 'near'} onPress={chooseNear} />
        </View>
        <ViewToggle view={view} onChange={setView} />
      </View>
      {error ? <Banner text={error} /> : null}
    </View>
  );

  if (view === 'map') {
    const center = here && mode === 'near' ? here : choice?.kind === 'city' ? choice.city : null;
    return (
      <View style={layout.screen}>
        <View style={styles.mapHeader}>{header}</View>
        <View style={{ flex: 1 }}>
          <RoutesMap routes={routes} center={center} />
          {loading ? (
            <View style={styles.mapNote} pointerEvents="none">
              <ActivityIndicator color={colors.forest} />
            </View>
          ) : !error && routes.length === 0 ? (
            <View style={styles.mapNote} pointerEvents="none">
              <Text style={styles.mapNoteText}>
                {debounced || mode === 'near' ? 'Ничего не нашлось' : 'Экскурсий пока нет'}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={layout.screen}>
      <FlatList
        data={routes}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <RouteCard route={item} />}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading && routes.length > 0} onRefresh={() => load(0)} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <View style={{ padding: space.xxl }}>
              <ActivityIndicator color={colors.forest} />
            </View>
          ) : error ? undefined : (
            <Empty
              icon="map-outline"
              title={
                debounced || mode === 'near'
                  ? 'Ничего не нашлось'
                  : city
                    ? `В городе ${city} экскурсий пока нет`
                    : 'Экскурсий пока нет'
              }
              text="Создайте первую на вкладке «Создать» и откройте её для всех."
            />
          )
        }
        ListFooterComponent={
          hasMore && routes.length > 0 ? (
            <Button title="Показать ещё" variant="secondary" onPress={() => load(routes.length)} loading={loading} />
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  city: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    minHeight: 48,
  },
  cityName: { flex: 1, fontFamily: serif, fontSize: 20, fontWeight: '700', color: colors.ink },
  cityChange: { color: colors.forest, fontWeight: '600', fontSize: 14 },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.sm,
  },
  mapHeader: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    padding: space.lg,
    paddingBottom: space.md,
  },
  mapNote: {
    position: 'absolute',
    top: space.md,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  mapNoteText: { fontSize: 14, color: colors.ink },
  list: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', padding: space.lg, gap: space.md },
});
