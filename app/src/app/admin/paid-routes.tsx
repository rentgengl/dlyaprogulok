import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime } from '@/components/admin';
import { Banner, Button, Chip, Field } from '@/components/ui';
import { adminApi } from '@/lib/adminApi';
import { formatDistance, pluralStops } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import type { Route, SaleStatus } from '@/lib/types';

const TABS: { status: SaleStatus; label: string }[] = [
  { status: 'pending', label: 'На проверке' },
  { status: 'approved', label: 'В продаже' },
  { status: 'rejected', label: 'Отклонены' },
  { status: 'delisted', label: 'Сняты' },
];

/** Проверка платных маршрутов (FR-012a, FR-012b): содержимое, одобрить, отклонить или снять с причиной. */
export default function AdminPaidRoutes() {
  const [status, setStatus] = useState<SaleStatus>('pending');
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRoutes((await adminApi.paidRoutes(status)).routes);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Платные маршруты</Text>
      <View style={adminStyles.inline}>
        {TABS.map((t) => (
          <Chip key={t.status} label={t.label} active={status === t.status} onPress={() => setStatus(t.status)} />
        ))}
      </View>
      {error ? <Banner text={error} /> : null}
      {routes && routes.length === 0 ? <Text style={adminStyles.rowMeta}>Пусто.</Text> : null}
      {routes?.map((r) => (
        <Review key={r.id} route={r} onDone={() => setRoutes((list) => list?.filter((x) => x.id !== r.id) ?? null)} />
      ))}
    </AdminPage>
  );
}

function Review({ route, onDone }: { route: Route; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = route.sale?.status;

  const decide = async (decision: 'approve' | 'reject' | 'delist') => {
    if (decision !== 'approve' && !note.trim()) {
      setError('Укажите причину: её получит автор');
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await adminApi.saleDecision(route.id, decision, note.trim() || undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const withStory = route.points.filter((p) => p.story).length;
  const narrated = route.points.filter((p) => p.narrationUrl).length;

  return (
    <View style={adminStyles.row}>
      <View style={adminStyles.inline}>
        <Text style={[adminStyles.rowTitle, { flex: 1 }]}>{route.title}</Text>
        <Badge text={`${route.price ?? '—'} баллов`} tone="good" />
      </View>
      <Text style={adminStyles.rowMeta}>
        {route.ownerName} · {route.city ?? 'город не указан'} · {formatDistance(route.distanceM)} · {pluralStops(route.points.length)} ·
        рассказов {withStory}, озвучено {narrated}
        {route.buyers ? ` · открыли ${route.buyers}` : ''}
      </Text>
      {route.sale?.decidedAt ? (
        <Text style={adminStyles.rowMeta}>
          Решение: {formatDateTime(route.sale.decidedAt)}
          {route.sale.note ? ` · ${route.sale.note}` : ''}
        </Text>
      ) : null}
      {route.description ? <Text style={{ color: colors.ink }}>{route.description}</Text> : null}
      <View style={adminStyles.inline}>
        <Pressable onPress={() => setOpen((v) => !v)}>
          <Text style={adminStyles.link}>{open ? 'Скрыть содержимое' : 'Показать точки и рассказы'}</Text>
        </Pressable>
        <Pressable onPress={() => router.push({ pathname: '/route/[id]', params: { id: route.id } })}>
          <Text style={adminStyles.link}>Открыть маршрут</Text>
        </Pressable>
      </View>
      {open
        ? route.points.map((p, i) => (
            <View key={p.id} style={{ gap: 2, paddingVertical: space.xs }}>
              <Text style={{ fontWeight: '700', color: colors.ink }}>
                {i + 1}. {p.name}
              </Text>
              {p.story ? <Text style={{ color: colors.ink }}>{p.story}</Text> : <Text style={adminStyles.rowMeta}>Без рассказа</Text>}
              {p.media.length ? <Text style={adminStyles.rowMeta}>Файлов автора: {p.media.length}</Text> : null}
            </View>
          ))
        : null}
      {status === 'pending' || status === 'approved' || status === 'delisted' ? (
        <>
          <Field value={note} onChangeText={setNote} placeholder="Причина отказа или снятия — уйдёт автору" maxLength={1000} multiline />
          <View style={adminStyles.inline}>
            {status === 'pending' || status === 'delisted' ? (
              <Button title={status === 'delisted' ? 'Вернуть в продажу' : 'Одобрить и опубликовать'} onPress={() => decide('approve')} loading={busy === 'approve'} disabled={!!busy} />
            ) : null}
            {status === 'pending' ? (
              <Button title="Отклонить" variant="danger" onPress={() => decide('reject')} loading={busy === 'reject'} disabled={!!busy} />
            ) : null}
            {status === 'approved' ? (
              <Button title="Снять с продажи" variant="danger" onPress={() => decide('delist')} loading={busy === 'delist'} disabled={!!busy} />
            ) : null}
          </View>
        </>
      ) : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}
