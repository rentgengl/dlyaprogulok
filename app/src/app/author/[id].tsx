import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { RouteCard } from '@/components/RouteCard';
import { TipButton } from '@/components/TipSheet';
import { Banner, Centered, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { pluralRoutes } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import type { RouteSummary } from '@/lib/types';

/** Страница автора: имя, открытые маршруты и «Поддержать автора» (FR-018). */
export default function AuthorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [data, setData] = useState<{ author: { id: string; name: string }; routes: RouteSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.author(id).then(
      (res) => !off && setData(res),
      (err) => !off && setError(err instanceof ApiError ? err.message : 'Не удалось загрузить автора'),
    );
    return () => {
      off = true;
    };
  }, [id]);

  if (!data) {
    return (
      <View style={layout.screen}>
        <Stack.Screen options={{ title: 'Автор' }} />
        <Centered>{error ? <Banner text={error} /> : <ActivityIndicator color={colors.forest} />}</Centered>
      </View>
    );
  }

  const deleted = data.author.name === 'Удалённый автор' && data.routes.length === 0;
  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content}>
      <Stack.Screen options={{ title: data.author.name }} />
      <View style={{ gap: space.xs }}>
        <Text style={layout.h1}>{data.author.name}</Text>
        <Text style={layout.muted}>{data.routes.length ? `${pluralRoutes(data.routes.length)} в каталоге` : 'Открытых маршрутов пока нет'}</Text>
      </View>
      {info ? <Banner tone="info" text={info} /> : null}
      {user && user.id !== data.author.id && !deleted ? (
        <TipButton authorId={data.author.id} authorName={data.author.name} onSent={setInfo} />
      ) : null}
      {data.routes.map((r) => (
        <RouteCard key={r.id} route={r} />
      ))}
    </ScrollView>
  );
}
