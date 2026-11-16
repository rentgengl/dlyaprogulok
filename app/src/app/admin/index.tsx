import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatBytes, Stat } from '@/components/admin';
import { Banner, layout } from '@/components/ui';
import { adminApi, type AdminStats } from '@/lib/adminApi';
import { space } from '@/lib/theme';

export default function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await adminApi.stats());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const s = stats?.services;
  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Обзор</Text>
      {error ? <Banner text={error} /> : null}
      {stats ? (
        <>
          <View style={adminStyles.grid}>
            <Stat label="Пользователей" value={stats.users.total} hint={`${stats.users.newThisMonth} за месяц · ${stats.users.verified} подтвердили почту`} />
            <Stat label="Маршрутов" value={stats.routes.total} hint={`${stats.routes.public} в каталоге`} />
            <Stat label="Создано в этом месяце" value={stats.routes.generatedThisMonth} hint="Учитываются и удалённые" />
            <Stat label="Точек" value={stats.points.total} hint={`${stats.points.withStory} с рассказом · ${stats.points.narrated} с озвучкой`} />
            <Stat label="Файлы" value={formatBytes(stats.media.bytes)} hint={`${stats.media.files} шт.: озвучка и вложения`} />
            <Stat label="Администраторов" value={stats.users.admins} hint={stats.users.blocked ? `Заблокировано: ${stats.users.blocked}` : 'Заблокированных нет'} />
          </View>
          {s ? (
            <View style={layout.card}>
              <Text style={layout.h2}>Сервисы</Text>
              <ServiceRow name="ИИ" value={s.ai.provider ? `${s.ai.provider}, ${s.ai.model ?? 'модель по умолчанию'}` : null} off="выключен: подбор эвристический, рассказы из Википедии" />
              <ServiceRow name="Озвучка" value={s.tts} off="выключена: читает голос устройства" />
              <ServiceRow name="Почта" value={s.mailer} off="не настроена: подтверждение почты не требуется" />
              <ServiceRow name="Лимит" value={s.routeMonthlyLimit ? `${s.routeMonthlyLimit} маршрутов в месяц` : 'без ограничения'} />
              <ServiceRow name="Сайт" value={s.appUrl} />
            </View>
          ) : null}
        </>
      ) : null}
    </AdminPage>
  );
}

function ServiceRow({ name, value, off }: { name: string; value: string | null; off?: string }) {
  return (
    <View style={[adminStyles.inline, { gap: space.md }]}>
      <Text style={[layout.label, { width: 80 }]}>{name}</Text>
      {value ? <Text style={layout.body}>{value}</Text> : <Badge text={off ?? 'нет'} tone="warn" />}
    </View>
  );
}
