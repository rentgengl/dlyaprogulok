import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { RouteMap } from '@/components/RouteMap';
import { Banner, Button, Chip, Field, layout, SignInPrompt } from '@/components/ui';
import { VerifyEmailCard } from '@/components/VerifyEmail';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCity } from '@/lib/city';
import { formatDistance, formatDuration, quotaText } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import { STORY_STYLE_LABEL, type GeocodeResult, type Job, type LatLng, type StoryStyle } from '@/lib/types';

const DURATIONS = [30, 60, 90, 120, 180];
const DISTANCES = [1000, 2000, 3000, 5000, 8000];

export default function CreateScreen() {
  const { user, ready, setUser, refresh } = useAuth();
  const { choice } = useCity();
  const city = choice?.kind === 'city' ? choice.city : null;
  const [start, setStart] = useState<(LatLng & { label?: string }) | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [mode, setMode] = useState<'duration' | 'distance'>('duration');
  const [duration, setDuration] = useState(60);
  const [distance, setDistance] = useState(3000);
  const [roundTrip, setRoundTrip] = useState(true);
  const [interests, setInterests] = useState('');
  const [autoStories, setAutoStories] = useState(true);
  const [storyStyle, setStoryStyle] = useState<StoryStyle>('facts');
  /** auto — подбор мест сервером; manual — пустой маршрут, места автор добавляет сам. */
  const [kind, setKind] = useState<'auto' | 'manual'>('auto');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Подбор идёт на сервере: ждём, пока в задаче появится маршрут. */
  const [pending, setPending] = useState<Job | null>(null);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const { job } = await api.job(pending.id);
        if (job.routeId) {
          setPending(null);
          setBusy(false);
          router.push({
            pathname: '/route/[id]',
            params: { id: job.routeId, ...(job.notices.length ? { notice: job.notices.join(' ') } : {}) },
          });
        } else if (job.status === 'failed') {
          setPending(null);
          setBusy(false);
          setError(job.error ?? 'Не удалось построить маршрут');
          refresh();
        }
      } catch {
        // Связь пропала — спросим ещё раз на следующем шаге.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  if (!ready) return <View style={layout.screen} />;
  if (!user) {
    return (
      <View style={layout.screen}>
        <SignInPrompt text="Войдите, чтобы создавать маршруты. Открытые экскурсии доступны и без аккаунта." />
      </View>
    );
  }

  const quota = quotaText(user.quota);
  // Лимит исчерпан или почта не подтверждена: сервер всё равно откажет, кнопку лучше выключить сразу.
  const blocked = !user.emailVerified || (kind === 'auto' && user.quota.remaining === 0);

  const runSearch = async () => {
    if (search.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setResults((await api.geocode(search.trim(), city ?? undefined)).results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Поиск не удался');
    } finally {
      setSearching(false);
    }
  };

  const useMyLocation = async () => {
    setLocating(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error('Нет доступа к геолокации. Найдите адрес или нажмите на карту.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Моё местоположение' });
      setResults(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось определить местоположение');
    } finally {
      setLocating(false);
    }
  };

  const generate = async () => {
    if (!start) return;
    setBusy(true);
    setError(null);
    try {
      const label = start.label === 'Моё местоположение' ? undefined : start.label;
      const { job, quota } = await api.generateInBackground({
        start: { lat: start.lat, lng: start.lng, label },
        ...(mode === 'duration' ? { durationMin: duration } : { distanceM: distance }),
        roundTrip,
        interests: interests.trim() || undefined,
        storyStyle,
        autoStories,
      });
      setUser({ ...user, quota });
      setPending(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось построить маршрут');
      setBusy(false);
    }
  };

  const createManual = async () => {
    if (!start || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const label = start.label === 'Моё местоположение' ? undefined : start.label;
      const { route } = await api.createRoute({
        title: title.trim(),
        description: description.trim() || undefined,
        start: { lat: start.lat, lng: start.lng, label },
        roundTrip,
        storyStyle,
      });
      setTitle('');
      setDescription('');
      router.push({ pathname: '/route/[id]', params: { id: route.id, add: '1' } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать маршрут');
    } finally {
      setBusy(false);
    }
  };

  const roundTripSwitch = (
    <View style={styles.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={layout.body}>Вернуться к старту</Text>
        <Text style={layout.muted}>Кольцевой маршрут вместо прогулки в одну сторону</Text>
      </View>
      <Switch value={roundTrip} onValueChange={setRoundTrip} trackColor={{ true: colors.forest }} />
    </View>
  );

  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
      <VerifyEmailCard />
      <View style={{ gap: space.xs }}>
        <View style={layout.row} role="tablist">
          <Chip label="Подобрать автоматически" active={kind === 'auto'} onPress={() => setKind('auto')} />
          <Chip label="Составить вручную" active={kind === 'manual'} onPress={() => setKind('manual')} />
        </View>
        <Text style={layout.muted}>
          {kind === 'auto'
            ? 'Места подберём сами, путь проложим по улицам.'
            : 'Задайте старт и название, а места добавите сами: поиском, из списка мест рядом или нажатием на карту. Рассказы можно написать самому. Месячный лимит не расходуется.'}
        </Text>
      </View>
      {kind === 'auto' && user.quota.remaining === 0 && quota ? <Banner tone="info" text={quota} /> : null}
      <Section number={1} title="Откуда начнём?">
        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <Field
              placeholder={city ? `Адрес или место: ${city.name}` : 'Адрес или место'}
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={runSearch}
              returnKeyType="search"
              aria-label="Адрес старта"
            />
          </View>
          <Button title="Найти" variant="secondary" onPress={runSearch} loading={searching} />
        </View>
        {results ? (
          results.length === 0 ? (
            <Text style={layout.muted}>Ничего не нашлось. Попробуйте уточнить адрес.</Text>
          ) : (
            <View style={styles.results}>
              {results.map((r, i) => (
                <Pressable
                  key={`${r.lat},${r.lng},${i}`}
                  role="button"
                  style={[styles.result, i > 0 && styles.resultBorder]}
                  onPress={() => {
                    setStart({ lat: r.lat, lng: r.lng, label: r.name });
                    setResults(null);
                    setSearch(r.name.split(',')[0] ?? r.name);
                  }}
                >
                  <Text style={styles.resultText} numberOfLines={2}>
                    {r.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )
        ) : null}
        <Button title="Моё местоположение" icon="navigate-outline" variant="secondary" onPress={useMyLocation} loading={locating} />
        <View style={styles.map}>
          <RouteMap
            start={start}
            center={city}
            fitKey={start ? `${start.lat},${start.lng}` : city ? `city:${city.name}` : undefined}
            onPress={(p) => {
              setStart({ ...p, label: undefined });
              setResults(null);
            }}
          />
        </View>
        <Text style={layout.muted}>
          {start ? start.label ?? 'Точка на карте' : 'Или нажмите на карту, чтобы поставить старт.'}
        </Text>
      </Section>

      {kind === 'manual' ? (
        <Section number={2} title="Название и формат">
          <Field label="Название" placeholder="Например: дворы Петроградской" value={title} onChangeText={setTitle} maxLength={120} />
          <Field
            label="Описание"
            placeholder="Необязательно: о чём эта прогулка"
            value={description}
            onChangeText={setDescription}
            maxLength={1000}
            multiline
            style={{ minHeight: 72, textAlignVertical: 'top' }}
          />
          {roundTripSwitch}
          <View style={{ gap: space.xs }}>
            <Text style={layout.body}>Направление рассказов</Text>
            <View style={layout.row}>
              {(['facts', 'legends'] as const).map((s) => (
                <Chip key={s} label={STORY_STYLE_LABEL[s]} active={storyStyle === s} onPress={() => setStoryStyle(s)} />
              ))}
            </View>
            <Text style={layout.muted}>Пригодится, если для какой-то точки попросите составить рассказ автоматически.</Text>
          </View>
        </Section>
      ) : null}

      {kind === 'auto' ? (
      <>
      <Section number={2} title="Сколько гуляем?">
        <View style={layout.row}>
          <Chip label="По времени" active={mode === 'duration'} onPress={() => setMode('duration')} />
          <Chip label="По длине" active={mode === 'distance'} onPress={() => setMode('distance')} />
        </View>
        <View style={layout.row}>
          {mode === 'duration'
            ? DURATIONS.map((d) => <Chip key={d} label={formatDuration(d)} active={duration === d} onPress={() => setDuration(d)} />)
            : DISTANCES.map((d) => <Chip key={d} label={formatDistance(d)} active={distance === d} onPress={() => setDistance(d)} />)}
        </View>
        {roundTripSwitch}
      </Section>

      <Section number={3} title="Что интересно?">
        <Field
          placeholder="Например: конструктивизм, купеческая история, тихие дворы"
          value={interests}
          onChangeText={setInterests}
          maxLength={300}
          multiline
          aria-label="Пожелания к маршруту"
          style={{ minHeight: 72, textAlignVertical: 'top' }}
        />
        <View style={{ gap: space.xs }}>
          <Text style={layout.body}>О чём рассказывать</Text>
          <View style={layout.row}>
            {(['facts', 'legends'] as const).map((s) => (
              <Chip key={s} label={STORY_STYLE_LABEL[s]} active={storyStyle === s} onPress={() => setStoryStyle(s)} />
            ))}
          </View>
          <Text style={layout.muted}>
            {storyStyle === 'facts'
              ? 'История места, кто и когда его создал, чем оно примечательно.'
              : 'Предания, городские легенды и поверья — с пометкой, где легенда, а где факт.'}
          </Text>
        </View>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={layout.body}>Сразу создать аудиорассказы</Text>
            <Text style={layout.muted}>Для каждой остановки, это займёт пару минут</Text>
          </View>
          <Switch value={autoStories} onValueChange={setAutoStories} trackColor={{ true: colors.forest }} />
        </View>
      </Section>

      </>
      ) : null}

      {error ? <Banner text={error} /> : null}
      {kind === 'auto' ? (
        <>
          {quota ? <Text style={[layout.muted, { textAlign: 'center' }]}>{quota}</Text> : null}
          <Button
            title={busy ? 'Подбираем места и прокладываем путь…' : 'Построить маршрут'}
            icon={busy ? undefined : 'sparkles'}
            onPress={generate}
            loading={busy}
            disabled={!start || blocked}
          />
          {pending ? (
            <Text style={[layout.muted, { textAlign: 'center' }]}>
              Маршрут строится на сервере, обычно это меньше минуты. Можно уйти с этого экрана: готовый маршрут появится в «Моих».
            </Text>
          ) : null}
        </>
      ) : (
        <Button
          title="Создать маршрут и добавить места"
          icon="create-outline"
          onPress={createManual}
          loading={busy}
          disabled={!start || !title.trim() || blocked}
        />
      )}
      {!start ? (
        <Text style={[layout.muted, { textAlign: 'center' }]}>Сначала выберите точку старта</Text>
      ) : kind === 'manual' && !title.trim() ? (
        <Text style={[layout.muted, { textAlign: 'center' }]}>Укажите название</Text>
      ) : null}
    </ScrollView>
  );
}

function Section({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <View style={layout.card}>
      <View style={styles.sectionHead}>
        <View style={styles.number}>
          <Text style={styles.numberText}>{number}</Text>
        </View>
        <Text style={layout.h2}>{title}</Text>
      </View>
      <View style={{ gap: space.md }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs },
  number: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  searchRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  results: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  result: { padding: space.md, backgroundColor: colors.white },
  resultBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  resultText: { fontSize: 14, lineHeight: 20, color: colors.ink },
  map: { height: 260, borderRadius: radius.md, overflow: 'hidden' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
