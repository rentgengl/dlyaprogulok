import * as Location from 'expo-location';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { colors, radius, space } from '@/lib/theme';
import type { GeocodeResult, LatLng, Route } from '@/lib/types';
import { Banner, Button, Chip, Field, layout } from './ui';

export type EndpointTarget = 'start' | 'finish';
export type Draft = LatLng & { label?: string };

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : 'Что-то пошло не так');
const short = (label: string | null | undefined) => label?.split(',')[0] || 'Точка на карте';

/** Подпись для всех: откуда начинается и где заканчивается прогулка. */
export function endpointsText(route: Route): string {
  const finish = route.finish
    ? short(route.finish.label)
    : route.roundTrip
      ? 'возврат к старту'
      : (route.points.at(-1)?.name ?? 'последняя точка');
  return `Старт: ${short(route.start.label)} · Финиш: ${finish}`;
}

/**
 * Старт и финиш маршрута. Старт переносится поиском, нажатием на карту или по геолокации;
 * финиш — у старта (кольцо), на последней точке или в своём месте. Путь пересчитывается на сервере.
 */
export function EndpointsCard({
  route,
  editing,
  onEdit,
  draft,
  onDraft,
  onRoute,
}: {
  route: Route;
  editing: EndpointTarget | null;
  onEdit: (t: EndpointTarget | null) => void;
  draft: Draft | null;
  onDraft: (d: Draft | null) => void;
  onRoute: (route: Route) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);

  const finishType = route.finish ? 'point' : route.roundTrip ? 'start' : 'last';

  const save = async (key: string, body: Parameters<typeof api.updateEndpoints>[1]) => {
    setBusy(key);
    setError(null);
    try {
      onRoute((await api.updateEndpoints(route.id, body)).route);
      onDraft(null);
      onEdit(null);
      setResults(null);
      setQuery('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const search = async () => {
    if (query.trim().length < 2) return;
    setBusy('search');
    setError(null);
    try {
      setResults((await api.geocode(query.trim(), route.start)).results);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const here = async () => {
    setBusy('here');
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error('Нет доступа к геолокации. Найдите адрес или нажмите на карту.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      onDraft({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const open = (t: EndpointTarget) => {
    onDraft(null);
    setResults(null);
    setError(null);
    onEdit(t);
  };

  return (
    <View style={layout.card}>
      <Text style={layout.h2}>Старт и финиш</Text>

      <View style={styles.row}>
        <View style={[styles.dot, styles.startDot]} />
        <View style={{ flex: 1 }}>
          <Text style={layout.label}>Старт</Text>
          <Text style={layout.body} numberOfLines={2}>
            {short(route.start.label)}
          </Text>
        </View>
        <Button title="Изменить" variant="secondary" disabled={editing === 'start'} onPress={() => open('start')} />
      </View>

      <View style={{ gap: space.sm }}>
        <View style={styles.row}>
          <View style={[styles.dot, styles.finishDot]} />
          <Text style={layout.label}>Финиш</Text>
        </View>
        <View style={layout.row}>
          <Chip
            label="У старта"
            active={finishType === 'start' && editing !== 'finish'}
            onPress={() => save('start', { finish: { type: 'start' } })}
          />
          <Chip
            label="На последней точке"
            active={finishType === 'last' && editing !== 'finish'}
            onPress={() => save('last', { finish: { type: 'last' } })}
          />
          <Chip label="Своё место" active={finishType === 'point' || editing === 'finish'} onPress={() => open('finish')} />
        </View>
        {route.finish && editing !== 'finish' ? <Text style={layout.muted}>{short(route.finish.label)}</Text> : null}
      </View>

      {editing ? (
        <View style={styles.editor}>
          <Text style={layout.body}>
            {editing === 'start' ? 'Новый старт' : 'Где закончить прогулку'}: найдите адрес, нажмите на карту или
            возьмите своё местоположение.
          </Text>
          <View style={styles.searchRow}>
            <View style={{ flex: 1 }}>
              <Field
                placeholder="Адрес или место"
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={search}
                returnKeyType="search"
                aria-label={editing === 'start' ? 'Адрес нового старта' : 'Адрес финиша'}
              />
            </View>
            <Button title="Найти" variant="secondary" onPress={search} loading={busy === 'search'} />
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
                      onDraft({ lat: r.lat, lng: r.lng, label: r.name });
                      setResults(null);
                    }}
                  >
                    <Text style={layout.body} numberOfLines={2}>
                      {r.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )
          ) : null}
          <Button title="Моё местоположение" icon="navigate-outline" variant="secondary" onPress={here} loading={busy === 'here'} />
          {draft ? (
            <Text style={layout.muted}>Выбрано: {draft.label ? short(draft.label) : 'точка на карте'}</Text>
          ) : (
            <Banner tone="info" text="Или нажмите на карту — там появится метка «+»." />
          )}
          <View style={layout.row}>
            <Button
              title={editing === 'start' ? 'Сохранить старт' : 'Сохранить финиш'}
              icon="checkmark"
              disabled={!draft || !!busy}
              loading={busy === 'save'}
              onPress={() => {
                if (!draft) return;
                const place = { lat: draft.lat, lng: draft.lng, label: draft.label };
                save('save', editing === 'start' ? { start: place } : { finish: { type: 'point', ...place } });
              }}
            />
            <Button
              title="Отмена"
              variant="secondary"
              onPress={() => {
                onDraft(null);
                onEdit(null);
              }}
            />
          </View>
        </View>
      ) : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 18, height: 18 },
  startDot: { borderRadius: 9, borderWidth: 5, borderColor: colors.accent, backgroundColor: colors.white },
  finishDot: { borderRadius: 4, borderWidth: 2, borderColor: colors.forest, backgroundColor: colors.forestSoft },
  editor: { gap: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  searchRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  list: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  item: { padding: space.md, backgroundColor: colors.white },
  border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
