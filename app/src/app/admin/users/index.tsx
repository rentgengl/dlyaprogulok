import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime, limitText, Pager } from '@/components/admin';
import { Banner, Chip, Field } from '@/components/ui';
import { adminApi, type AdminUser } from '@/lib/adminApi';
import { space } from '@/lib/theme';

const LIMIT = 50;

export default function AdminUsers() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; users: AdminUser[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminApi.users({ q: query, filter, offset, limit: LIMIT }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, filter, offset]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Пользователи{data ? ` · ${data.total}` : ''}</Text>
      <View style={{ gap: space.sm }}>
        <Field
          value={q}
          onChangeText={setQ}
          placeholder="Email, имя или id"
          autoCapitalize="none"
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
            ['admins', 'Администраторы'],
            ['blocked', 'Заблокированные'],
            ['unverified', 'Почта не подтверждена'],
          ].map(([v, label]) => (
            <Chip key={v} label={label!} active={filter === v} onPress={() => (setOffset(0), setFilter(v!))} />
          ))}
        </View>
      </View>
      {error ? <Banner text={error} /> : null}
      {data?.users.length === 0 ? <Text style={adminStyles.rowMeta}>Никого не найдено.</Text> : null}
      {data?.users.map((u) => (
        <Pressable
          key={u.id}
          onPress={() => router.push(`/admin/users/${u.id}`)}
          style={({ pressed }) => [adminStyles.row, pressed && { opacity: 0.7 }]}
        >
          <View style={adminStyles.inline}>
            <Text style={adminStyles.rowTitle}>{u.name}</Text>
            <Text style={adminStyles.rowMeta}>{u.email}</Text>
            {u.isAdmin ? <Badge text="админ" tone="good" /> : null}
            {u.blocked ? <Badge text="заблокирован" tone="bad" /> : null}
            {!u.emailVerified ? <Badge text="почта не подтверждена" tone="warn" /> : null}
          </View>
          <Text style={adminStyles.rowMeta}>
            Маршрутов: {u.routeCount} · в этом месяце создано {u.usedThisMonth} · {limitText(u)} · с{' '}
            {formatDateTime(u.createdAt)}
            {u.activeSessions ? ` · сессий: ${u.activeSessions}` : ''}
          </Text>
        </Pressable>
      ))}
      {data ? <Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} /> : null}
    </AdminPage>
  );
}
