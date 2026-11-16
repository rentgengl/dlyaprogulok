import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { formatDistance } from '@/lib/format';
import { haversine } from '@/lib/geo';
import { colors, radius, space } from '@/lib/theme';
import type { GeocodeResult, LatLng, Route, Suggestion } from '@/lib/types';
import { Banner, Button, Chip, Field, layout } from './ui';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'().,-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Похоже на одно место: совсем рядом, то же название или одно название внутри другого неподалёку
 * («ГУМ» и «Государственный универсальный магазин (ГУМ)»: у большого здания координаты расходятся).
 */
function sameMaybe(a: LatLng & { name: string }, b: LatLng & { name: string }): boolean {
  const d = haversine(a, b);
  const x = norm(a.name);
  const y = norm(b.name);
  if (d < 40 || x === y) return true;
  const words = (s: string) => new Set(s.split(' '));
  return d < 300 && x.length > 1 && y.length > 1 && ([...words(x)].every((w) => words(y).has(w)) || [...words(y)].every((w) => words(x).has(w)));
}

export type AddMode = 'near' | 'search' | 'map';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Что-то пошло не так');

/**
 * Ручное добавление места: из подсказок рядом, поиском по адресу или нажатием на карту.
 * Точка встаёт туда, где крюк меньше всего; порядок потом можно поменять стрелками.
 */
export function AddPlace({
  route,
  mode,
  onModeChange,
  draft,
  onDraft,
  onAdded,
  onClose,
}: {
  route: Route;
  mode: AddMode;
  onModeChange: (m: AddMode) => void;
  draft: LatLng | null;
  onDraft: (p: LatLng | null) => void;
  onAdded: (res: { route: Route; pointId: string }) => void;
  onClose: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [name, setName] = useState('');
  const [teaser, setTeaser] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'near' || suggestions !== null) return;
    let stale = false;
    api
      .suggestions(route.id)
      .then((res) => {
        if (!stale) setSuggestions(res.suggestions);
      })
      .catch((err) => {
        if (!stale) {
          setError(message(err));
          setSuggestions([]);
        }
      })
    return () => {
      stale = true;
    };
  }, [mode, route.id, suggestions]);
  const loadingNear = mode === 'near' && suggestions === null;

  const add = async (
    key: string,
    place: LatLng & { name: string; teaser?: string; kind?: string; wikiTitle?: string; wikidata?: string; heritageRef?: string },
  ) => {
    // Поиск и карта не знают, что уже есть в маршруте: переспрашиваем, а не запрещаем.
    const twin = route.points.find((p) => sameMaybe(p, place));
    if (twin && !(await confirm(`Похоже, это место уже есть в маршруте: «${twin.name}». Добавить ещё раз?`, 'Добавить'))) return;
    setBusy(key);
    setError(null);
    try {
      const res = await api.addPoint(route.id, place);
      setSuggestions((prev) => prev?.filter((s) => !(s.lat === place.lat && s.lng === place.lng)) ?? null);
      setName('');
      setTeaser('');
      onDraft(null);
      onAdded(res);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const search = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setResults((await api.geocode(query.trim(), route.start)).results);
    } catch (err) {
      setError(message(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <View style={[layout.card, styles.panel]}>
      <View style={styles.head}>
        <Text style={[layout.h2, { flex: 1 }]}>Добавить место</Text>
        <Pressable role="button" aria-label="Закрыть" hitSlop={8} onPress={onClose}>
          <Ionicons name="close" size={24} color={colors.muted} />
        </Pressable>
      </View>
      <View style={layout.row}>
        <Chip label="Рядом" active={mode === 'near'} onPress={() => onModeChange('near')} />
        <Chip label="Найти" active={mode === 'search'} onPress={() => onModeChange('search')} />
        <Chip label="На карте" active={mode === 'map'} onPress={() => onModeChange('map')} />
      </View>

      {mode === 'near' ? (
        loadingNear ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.forest} />
            <Text style={layout.muted}>Ищем интересные места вокруг маршрута…</Text>
          </View>
        ) : suggestions?.length ? (
          <View style={styles.list}>
            {suggestions.map((s, i) => {
              const key = `s${i}`;
              return (
                <View key={`${s.lat},${s.lng}`} style={[styles.item, i > 0 && styles.border]}>
                  <Pressable role="button" style={{ flex: 1 }} onPress={() => onDraft(s)} aria-label={`Показать на карте: ${s.name}`}>
                    <Text style={styles.itemName}>{s.name}</Text>
                    <Text style={layout.muted} numberOfLines={2}>
                      {[s.about, `${formatDistance(s.distanceM)} от маршрута`].filter(Boolean).join(' · ')}
                    </Text>
                  </Pressable>
                  <Button
                    title="Добавить"
                    variant="secondary"
                    loading={busy === key}
                    disabled={!!busy}
                    onPress={() =>
                      add(key, {
                        name: s.name,
                        lat: s.lat,
                        lng: s.lng,
                        teaser: s.about ?? undefined,
                        kind: s.kind,
                        wikiTitle: s.wikiTitle ?? undefined,
                        wikidata: s.wikidata ?? undefined,
                        heritageRef: s.heritageRef ?? undefined,
                      })
                    }
                  />
                </View>
              );
            })}
          </View>
        ) : suggestions ? (
          <Text style={layout.muted}>Рядом ничего не нашлось. Найдите место по адресу или отметьте на карте.</Text>
        ) : null
      ) : null}

      {mode === 'search' ? (
        <>
          <View style={styles.searchRow}>
            <View style={{ flex: 1 }}>
              <Field
                placeholder="Название или адрес"
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={search}
                returnKeyType="search"
                aria-label="Поиск места"
              />
            </View>
            <Button title="Найти" variant="secondary" onPress={search} loading={searching} />
          </View>
          {results ? (
            results.length === 0 ? (
              <Text style={layout.muted}>Ничего не нашлось.</Text>
            ) : (
              <View style={styles.list}>
                {results.map((r, i) => (
                  <Pressable
                    key={`${r.lat},${r.lng},${i}`}
                    role="button"
                    style={[styles.item, i > 0 && styles.border]}
                    onPress={() => {
                      onDraft(r);
                      setName(r.name.split(',')[0] ?? r.name);
                      setResults(null);
                    }}
                  >
                    <Text style={[layout.body, { flex: 1 }]} numberOfLines={2}>
                      {r.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )
          ) : null}
        </>
      ) : null}

      {mode === 'map' && !draft ? (
        <Banner tone="info" text="Нажмите на карту там, где находится место." />
      ) : null}

      {draft && mode !== 'near' ? (
        <View style={{ gap: space.sm }}>
          <Field label="Название" value={name} onChangeText={setName} maxLength={200} placeholder="Например: дворик с фонтаном" />
          <Field label="Коротко о месте" value={teaser} onChangeText={setTeaser} maxLength={500} placeholder="Необязательно" />
          <View style={layout.row}>
            <Button
              title="Добавить в маршрут"
              icon="add"
              loading={busy === 'draft'}
              disabled={!name.trim() || !!busy}
              onPress={() => add('draft', { ...draft, name: name.trim(), teaser: teaser.trim() || undefined })}
            />
            <Button title="Сбросить" variant="secondary" onPress={() => onDraft(null)} />
          </View>
        </View>
      ) : null}

      {error ? <Banner text={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderColor: colors.accent, borderWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  loading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  list: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: colors.white },
  border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  itemName: { fontSize: 15, fontWeight: '600', color: colors.ink },
  searchRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
});
