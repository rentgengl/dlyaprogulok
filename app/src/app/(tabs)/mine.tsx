import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { RouteCard } from '@/components/RouteCard';
import { RoutesMap, useRoutesView, ViewToggle } from '@/components/RoutesMap';
import { Banner, Empty, SignInPrompt, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, CONTENT_MAX_WIDTH, space } from '@/lib/theme';
import type { Job, RouteSummary } from '@/lib/types';

export default function MineScreen() {
  const { user, ready } = useAuth();
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useRoutesView();
  /** Маршруты, которые ещё подбираются на сервере, и неудачные попытки за последний час. */
  const [jobs, setJobs] = useState<Job[]>([]);

  /** silent — фоновое обновление, пока строится маршрут: без индикатора. */
  const load = useCallback(async (silent = false) => {
    if (!user) return;
    setError(null);
    if (!silent) setRefreshing(true);
    try {
      const [mine, active] = await Promise.all([api.mine(), api.jobs().catch(() => ({ jobs: [] as Job[] }))]);
      setRoutes(mine.routes);
      setJobs(active.jobs.filter((j) => j.kind === 'generate' && !j.routeId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
    } finally {
      setRefreshing(false);
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Пока что-то строится, список обновляется сам: готовый маршрут появится без перезагрузки.
  const building = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => load(true), 3000);
    return () => clearInterval(timer);
  }, [building, load]);

  if (!ready) return <View style={layout.screen} />;
  if (!user) {
    return (
      <View style={layout.screen}>
        <SignInPrompt text="Здесь будут маршруты, которые вы создали." />
      </View>
    );
  }

  const toolbar = routes?.length ? <ViewToggle view={view} onChange={setView} /> : null;

  if (view === 'map' && routes?.length) {
    return (
      <View style={layout.screen}>
        <View style={styles.mapHeader}>
          {error ? <Banner text={error} /> : null}
          {toolbar}
        </View>
        <RoutesMap routes={routes} showVisibility />
      </View>
    );
  }

  return (
    <View style={layout.screen}>
      <FlatList
        data={routes ?? []}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <RouteCard route={item} showVisibility />}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing && routes !== null} onRefresh={() => load()} />}
        ListHeaderComponent={
          error || toolbar || jobs.length ? (
            <View style={{ gap: space.md }}>
              {error ? <Banner text={error} /> : null}
              {jobs.map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
              {toolbar}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          routes === null ? (
            error ? undefined : (
              <View style={{ padding: space.xxl }}>
                <ActivityIndicator color={colors.forest} />
              </View>
            )
          ) : (
            <Empty
              icon="bookmark-outline"
              title="Маршрутов пока нет"
              text="Укажите старт и длительность на вкладке «Создать», а маршрут соберётся сам."
            />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mapHeader: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    padding: space.lg,
    paddingBottom: space.md,
    gap: space.md,
  },
  list: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', padding: space.lg, gap: space.md },
});

function JobCard({ job }: { job: Job }) {
  const label = job.params.request?.start?.label;
  const failed = job.status === 'failed';
  return (
    <View style={[layout.card, { flexDirection: 'row', alignItems: 'center', gap: space.md }]}>
      {failed ? null : <ActivityIndicator color={colors.forest} />}
      <View style={{ flex: 1, gap: space.xs }}>
        <Text style={layout.body}>
          {failed ? 'Маршрут не построен' : 'Строим маршрут'}
          {label ? ` от «${label.split(',')[0]}»` : ''}
          {failed ? '' : '…'}
        </Text>
        <Text style={layout.muted}>
          {failed ? job.error ?? 'Попробуйте ещё раз.' : job.status === 'queued' ? 'В очереди на сервере.' : 'Подбираем места и прокладываем путь.'}
        </Text>
      </View>
    </View>
  );
}
