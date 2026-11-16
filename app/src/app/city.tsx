import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Field, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useCity } from '@/lib/city';
import { colors, radius, serif, space } from '@/lib/theme';
import type { CityChoice, CitySearchResult, CityWithCount } from '@/lib/types';

const plural = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} экскурсия`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} экскурсии`;
  return `${n} экскурсий`;
};

/** Первый экран приложения и он же — смена города из каталога. */
export default function CityScreen() {
  const { choice, choose } = useCity();
  const firstTime = choice === null;
  const [popular, setPopular] = useState<CityWithCount[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CitySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchId = useRef(0);

  useEffect(() => {
    api
      .cities()
      .then((res) => setPopular(res.cities))
      .catch(() => setPopular([]));
  }, []);

  // Поиск по мере ввода: города называют по-разному, список подсказывает точное имя.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const id = ++searchId.current;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.searchCities(q);
        if (id === searchId.current) setResults(res.cities);
      } catch (err) {
        if (id === searchId.current) setError(err instanceof ApiError ? err.message : 'Поиск не удался');
      } finally {
        if (id === searchId.current) setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query]);

  const pick = (next: CityChoice) => {
    choose(next);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const locate = async () => {
    setLocating(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error('Нет доступа к геолокации. Найдите город по названию.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      const { city } = await api.locateCity({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      pick({ kind: 'city', city });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось определить город');
    } finally {
      setLocating(false);
    }
  };

  // Короткий запрос — подсказки прошлого поиска не показываем.
  const shown = query.trim().length >= 2 ? results : null;
  const current = choice?.kind === 'city' ? choice.city.name : null;

  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Город', headerBackVisible: !firstTime, gestureEnabled: !firstTime }} />
      <View style={{ gap: space.sm }}>
        <Text style={styles.title}>Где будем гулять?</Text>
        <Text style={layout.muted}>
          Покажем экскурсии этого города и начнём новый маршрут в нём. Город можно сменить в каталоге.
        </Text>
      </View>

      <Field
        placeholder="Название города"
        value={query}
        onChangeText={setQuery}
        aria-label="Поиск города"
        returnKeyType="search"
        autoFocus={firstTime}
      />
      {error ? <Banner text={error} /> : null}

      {shown ? (
        <View style={styles.list}>
          {shown.length === 0 ? (
            <Text style={[layout.muted, styles.item]}>Такого города не нашлось</Text>
          ) : (
            shown.map((c, i) => (
              <CityRow
                key={`${c.name}-${c.lat}-${c.lng}`}
                first={i === 0}
                name={c.name}
                note={c.region}
                onPress={() => pick({ kind: 'city', city: { name: c.name, lat: c.lat, lng: c.lng } })}
              />
            ))
          )}
        </View>
      ) : searching ? (
        <ActivityIndicator color={colors.forest} />
      ) : null}

      <Button title="Определить по геолокации" icon="navigate-outline" variant="secondary" onPress={locate} loading={locating} />

      <View style={{ gap: space.sm }}>
        <Text style={layout.h2}>Города с экскурсиями</Text>
        {popular === null ? (
          <ActivityIndicator color={colors.forest} />
        ) : (
          <View style={styles.list}>
            {popular.map((c, i) => (
              <CityRow
                key={c.name}
                first={i === 0}
                name={c.name}
                note={plural(c.count)}
                selected={c.name === current}
                onPress={() => pick({ kind: 'city', city: { name: c.name, lat: c.lat, lng: c.lng } })}
              />
            ))}
            <CityRow
              first={popular.length === 0}
              name="Все города"
              note="Каталог без отбора по месту"
              selected={choice?.kind === 'all'}
              onPress={() => pick({ kind: 'all' })}
            />
          </View>
        )}
        {popular?.length === 0 ? (
          <Text style={layout.muted}>Открытых экскурсий пока нет. Найдите свой город и создайте первую.</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function CityRow({
  name,
  note,
  first,
  selected,
  onPress,
}: {
  name: string;
  note: string;
  first: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-selected={selected}
      onPress={onPress}
      style={({ pressed }) => [styles.item, !first && styles.border, pressed && { backgroundColor: colors.forestSoft }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{name}</Text>
        {note ? <Text style={layout.muted}>{note}</Text> : null}
      </View>
      {selected ? <Ionicons name="checkmark" size={20} color={colors.forest} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: serif, fontSize: 30, lineHeight: 36, fontWeight: '700', color: colors.ink },
  list: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: 56 },
  border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
});
