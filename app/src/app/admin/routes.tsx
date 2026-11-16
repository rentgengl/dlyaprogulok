import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime, Pager } from '@/components/admin';
import { Banner, Button, Chip, Field } from '@/components/ui';
import { adminApi, type AdminRoute } from '@/lib/adminApi';
import { confirm } from '@/lib/confirm';
import { formatDistance, pluralStops } from '@/lib/format';
import { space } from '@/lib/theme';

const LIMIT = 50;

export default function AdminRoutes() {
  // ?owner=<id> — маршруты одного пользователя (переход со страницы пользователя).
  const params = useLocalSearchParams<{ owner?: string; q?: string }>();
  const [q, setQ] = useState(params.q ?? '');
  const [query, setQuery] = useState(params.q ?? '');
  const [visibility, setVisibility] = useState('all');
  const [sort, setSort] = useState('new');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; routes: AdminRoute[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminApi.routes({ q: query, owner: params.owner, visibility, sort, offset, limit: LIMIT }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, params.owner, visibility, sort, offset]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const replace = (route: AdminRoute) =>
    setData((d) => (d ? { ...d, routes: d.routes.map((r) => (r.id === route.id ? route : r)) } : d));

  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Маршруты{data ? ` · ${data.total}` : ''}</Text>
      {params.owner ? (
        <View style={adminStyles.inline}>
          <Badge text="Маршруты одного пользователя" />
          <Pressable onPress={() => router.setParams({ owner: undefined })}>
            <Text style={adminStyles.link}>Показать все</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ gap: space.sm }}>
        <Field
          value={q}
          onChangeText={setQ}
          placeholder="Название, город, адрес старта, email или имя автора"
          returnKeyType="search"
          onSubmitEditing={() => {
            setOffset(0);
            setQuery(q.trim());
          }}
          onBlur={() => {
            if (q.trim() !== query) {
              setOffset(0);
              setQuery(q.trim());
            }
          }}
        />
        <View style={adminStyles.inline}>
          {[
            ['all', 'Все'],
            ['public', 'В каталоге'],
            ['private', 'Скрытые'],
          ].map(([v, label]) => (
            <Chip key={v} label={label!} active={visibility === v} onPress={() => (setOffset(0), setVisibility(v!))} />
          ))}
          <View style={{ width: space.md }} />
          {[
            ['new', 'Новые'],
            ['old', 'Старые'],
            ['rating', 'По оценке'],
          ].map(([v, label]) => (
            <Chip key={v} label={label!} active={sort === v} onPress={() => (setOffset(0), setSort(v!))} />
          ))}
        </View>
      </View>
      {error ? <Banner text={error} /> : null}
      {data?.routes.length === 0 ? <Text style={adminStyles.rowMeta}>Ничего не найдено.</Text> : null}
      {data?.routes.map((r) => (
        <RouteRow
          key={r.id}
          route={r}
          onChanged={replace}
          onDeleted={() => setData((d) => (d ? { total: d.total - 1, routes: d.routes.filter((x) => x.id !== r.id) } : d))}
        />
      ))}
      {data ? <Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} /> : null}
    </AdminPage>
  );
}

function RouteRow({ route, onChanged, onDeleted }: { route: AdminRoute; onChanged: (r: AdminRoute) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={adminStyles.row}>
      <View style={adminStyles.inline}>
        <Pressable onPress={() => router.push(`/route/${route.id}`)} style={{ flexShrink: 1 }}>
          <Text style={[adminStyles.rowTitle, adminStyles.link]}>{route.title}</Text>
        </Pressable>
        {route.isPublic ? <Badge text="в каталоге" tone="good" /> : <Badge text="скрыт" />}
        {route.storyStyle === 'legends' ? <Badge text="легенды" tone="warn" /> : null}
        {route.rating.count ? <Badge text={`★ ${route.rating.avg} · ${route.rating.count}`} /> : null}
      </View>
      <Text style={adminStyles.rowMeta}>
        <Text style={adminStyles.link} onPress={() => router.push(`/admin/users/${route.ownerId}`)}>
          {route.ownerName} ({route.ownerEmail})
        </Text>
        {' · '}
        {[route.city, route.start.label].filter(Boolean).join(', ') || 'место не определено'}
        {' · '}
        {pluralStops(route.pointCount)}, {formatDistance(route.distanceM)}
        {' · '}создан {formatDateTime(route.createdAt)}
      </Text>
      {error ? <Banner text={error} /> : null}
      {transfer !== null ? (
        <View style={[adminStyles.inline, { alignItems: 'flex-end' }]}>
          <View style={{ flexGrow: 1, minWidth: 220 }}>
            <Field label="Новый автор: email или id" value={transfer} onChangeText={setTransfer} autoCapitalize="none" />
          </View>
          <Button
            title="Передать"
            loading={busy === 'transfer'}
            disabled={!transfer.trim()}
            onPress={() =>
              run('transfer', async () => {
                onChanged((await adminApi.updateRoute(route.id, { owner: transfer.trim() })).route);
                setTransfer(null);
              })
            }
          />
          <Button title="Отмена" variant="secondary" onPress={() => setTransfer(null)} />
        </View>
      ) : null}
      <View style={adminStyles.inline}>
        <Button title="Редактор" icon="create-outline" variant="secondary" onPress={() => router.push(`/route/${route.id}`)} />
        <Button
          title={route.isPublic ? 'Скрыть из каталога' : 'Опубликовать'}
          icon={route.isPublic ? 'eye-off-outline' : 'eye-outline'}
          variant="secondary"
          loading={busy === 'public'}
          onPress={() => run('public', async () => onChanged((await adminApi.updateRoute(route.id, { isPublic: !route.isPublic })).route))}
        />
        <Button title="Передать автору…" icon="swap-horizontal-outline" variant="secondary" onPress={() => setTransfer('')} />
        <Button
          title="Удалить"
          icon="trash-outline"
          variant="danger"
          loading={busy === 'delete'}
          onPress={async () => {
            if (!(await confirm(`Удалить маршрут «${route.title}»? Это нельзя отменить.`, 'Удалить'))) return;
            run('delete', async () => {
              await adminApi.deleteRoute(route.id);
              onDeleted();
            });
          }}
        />
      </View>
    </View>
  );
}
