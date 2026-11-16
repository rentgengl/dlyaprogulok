import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { AddPlace, type AddMode } from '@/components/AddPlace';
import { endpointsText, EndpointsCard, type Draft, type EndpointTarget } from '@/components/Endpoints';
import { ExportCard } from '@/components/ExportCard';
import { ShareCard } from '@/components/ShareCard';
import { AudioPlayer, DeviceVoicePlayer, VideoPlayer } from '@/components/Players';
import { RouteMap } from '@/components/RouteMap';
import { Banner, Button, Centered, Chip, Field, layout, Stars } from '@/components/ui';
import { api, ApiError, mediaUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirm } from '@/lib/confirm';
import { formatDistance, formatDuration, pluralStops } from '@/lib/format';
import { colors, radius, serif, space } from '@/lib/theme';
import {
  STORY_STYLE_LABEL,
  type Media,
  type PlacePhoto,
  type Route,
  type RoutePoint,
  type StorySource,
  type StoryStyle,
  type UploadAsset,
} from '@/lib/types';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Что-то пошло не так');

const SOURCE_NOTE: Record<StorySource, string> = {
  ai_sourced: 'Текст создан ИИ по статье Википедии. Возможны неточности.',
  ai_facts: 'Статьи о месте нет: текст создан ИИ по справке из Викиданных и реестра объектов культурного наследия. Возможны неточности.',
  ai: 'Текст создан ИИ без внешнего источника. Возможны неточности.',
  wikipedia: 'Текст из Википедии, лицензия CC BY-SA.',
  facts: 'Справка по данным Викиданных и реестра объектов культурного наследия.',
  author: 'Текст автора маршрута.',
};

const sourceLinkTitle = (url: string) => (url.includes('wikidata.org') ? 'Справка в Викиданных' : 'Статья-источник');

export default function RouteScreen() {
  // add=1 — маршрут только что создан вручную: сразу открыть добавление мест.
  const { id, notice, add } = useLocalSearchParams<{ id: string; notice?: string; add?: string }>();
  const { user, ready } = useAuth();
  const { width } = useWindowDimensions();
  const [route, setRoute] = useState<Route | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Задача, за которой следим на этом экране: по её окончании показываем итог. */
  const [watchedJob, setWatchedJob] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [endpointEdit, setEndpointEdit] = useState<EndpointTarget | null>(null);
  const [ordering, setOrdering] = useState(false);
  // Перезагрузка при входе/выходе: от пользователя зависят isOwner и myRating.
  useEffect(() => {
    // До восстановления входа приватный маршрут ответил бы 404.
    if (!ready) return;
    let stale = false;
    api
      .route(id)
      .then((res) => {
        if (stale) return;
        setRoute(res.route);
        setLoadError(null);
      })
      .catch((err) => {
        if (!stale) setLoadError(message(err));
      });
    return () => {
      stale = true;
    };
  }, [id, user?.id, ready, reloadKey]);

  const apply = (res: { route: Route; notices?: string[] }) => {
    setRoute(res.route);
    if (res.notices?.length) setInfo(res.notices.join(' '));
  };

  const run = async (fn: () => Promise<{ route: Route; notices?: string[] }>) => {
    setError(null);
    try {
      apply(await fn());
    } catch (err) {
      setError(message(err));
    }
  };

  /** Рассказы для точек без текста или, при смене направления, для всех с рассказом другого направления. Делает сервер в фоне. */
  const generateAllStories = useCallback(async (current: Route, redo = false) => {
    setError(null);
    try {
      const { job } = await api.routeStories(current.id, { style: current.storyStyle, redo });
      setRoute((r) => (r && r.id === current.id ? { ...r, job } : r));
    } catch (err) {
      setError(message(err));
    }
  }, []);

  // Пока задача идёт, маршрут перечитывается: рассказы появляются по мере готовности.
  const job = route?.job ?? null;
  const jobActive = !!job && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!jobActive) return;
    const timer = setInterval(() => {
      api
        .route(id)
        .then((res) => setRoute(res.route))
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [jobActive, id]);

  // Итог задачи — один раз, когда она закончилась у нас на глазах (или только что, до открытия экрана).
  if (job && jobActive && watchedJob !== job.id) setWatchedJob(job.id);
  if (job && !jobActive && watchedJob === job.id) {
    setWatchedJob(null);
    if (job.status === 'failed') setError(job.error ?? 'Не удалось создать рассказы');
    else if (job.failed > 0) setError(`Рассказов не создано: ${job.failed}. ${job.notices.join(' ')}`);
    else if (job.notices.length) setInfo(job.notices.join(' '));
  }

  // Пустой маршрут, созданный вручную: сразу открыть добавление мест (один раз за показ экрана).
  const [addHandled, setAddHandled] = useState(false);
  if (add && route?.canEdit && !addHandled) {
    setAddHandled(true);
    if (route.points.length === 0) setAddMode('near');
  }


  if (loadError && !route) {
    return (
      <View style={layout.screen}>
        <Stack.Screen options={{ title: 'Маршрут' }} />
        <Centered>
          <Ionicons name="alert-circle-outline" size={40} color={colors.muted} />
          <Text style={layout.h2}>{loadError}</Text>
          <Button title="Повторить" variant="secondary" onPress={() => setReloadKey((k) => k + 1)} />
        </Centered>
      </View>
    );
  }
  if (!route) {
    return (
      <View style={layout.screen}>
        <Stack.Screen options={{ title: 'Маршрут' }} />
        <Centered>
          <ActivityIndicator color={colors.forest} />
        </Centered>
      </View>
    );
  }

  const reorder = async (order: { pointIds: string[] } | { auto: true }) => {
    setOrdering(true);
    await run(() => api.reorder(route.id, order));
    setOrdering(false);
  };

  const move = (index: number, dir: -1 | 1) => {
    const ids = route.points.map((p) => p.id);
    const j = index + dir;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder({ pointIds: ids });
  };

  const closeAdding = () => {
    setAddMode(null);
    setDraft(null);
  };

  const storyProgress = jobActive && job ? { done: job.done, total: job.total, planning: job.stage === 'planning' || job.total === 0 } : null;
  const wide = width >= 900;
  const missingStories = route.points.filter((p) => !p.story).length;
  // Рассказы другого направления (текст автора не трогаем).
  const otherStyle = route.points.filter((p) => p.story && p.storySource !== 'author' && p.storyStyle !== route.storyStyle).length;
  const map = (
    <RouteMap
      start={route.start}
      points={route.points}
      geometry={route.geometry}
      selectedId={selectedId}
      draft={addMode || endpointEdit ? draft : null}
      finish={route.finish}
      // Вид подгоняется заново, когда меняется состав точек, старт или финиш, но не при выборе точки.
      fitKey={`${route.id}:${route.points.length}:${route.start.lat},${route.start.lng}:${route.finish?.lat ?? ''},${route.finish?.lng ?? ''}`}
      onMarkerPress={setSelectedId}
      onPress={
        addMode
          ? (p) => {
              setDraft(p);
              if (addMode === 'near') setAddMode('map');
            }
          : endpointEdit
            ? setDraft
            : undefined
      }
    />
  );

  const details = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.details} keyboardShouldPersistTaps="handled">
      {editing ? (
        <View style={{ gap: space.sm }}>
          <Field label="Название" value={draftTitle} onChangeText={setDraftTitle} maxLength={120} />
          <View style={layout.row}>
            <Button
              title="Сохранить"
              disabled={!draftTitle.trim()}
              onPress={async () => {
                await run(() => api.updateRoute(route.id, { title: draftTitle }));
                setEditing(false);
              }}
            />
            <Button title="Отмена" variant="secondary" onPress={() => setEditing(false)} />
          </View>
        </View>
      ) : (
        <View style={styles.titleRow}>
          <Text style={[layout.h1, { flex: 1 }]}>{route.title}</Text>
          {route.canEdit ? (
            <Pressable
              role="button"
              aria-label="Переименовать маршрут"
              hitSlop={8}
              onPress={() => {
                setDraftTitle(route.title);
                setEditing(true);
              }}
            >
              <Ionicons name="create-outline" size={22} color={colors.forest} />
            </Pressable>
          ) : null}
        </View>
      )}

      {route.description ? <Text style={layout.body}>{route.description}</Text> : null}
      <Text style={layout.muted}>
        {formatDistance(route.distanceM)} · {formatDuration(route.durationMin)} · {pluralStops(route.points.length)}
        {route.roundTrip ? ' · кольцевой' : ''} · {route.ownerName}
      </Text>
      <Text style={layout.muted}>{endpointsText(route)}</Text>

      {info ? <Banner tone="info" text={info} /> : null}
      {error ? <Banner text={error} /> : null}

      {route.canEdit && !route.isOwner ? (
        <Banner tone="info" text={`Чужой маршрут: автор — ${route.ownerName}. Вы правите его как администратор.`} />
      ) : null}
      {route.canEdit ? (
        <View style={layout.card}>
          <View style={styles.publishRow}>
            <View style={{ flex: 1 }}>
              <Text style={layout.body}>{route.isPublic ? 'Открыт для всех' : 'Виден только вам'}</Text>
              <Text style={layout.muted}>
                {route.isPublic ? 'Маршрут есть в общем каталоге' : 'Откройте доступ, и маршрут появится в каталоге'}
              </Text>
            </View>
            <Switch
              aria-label="Открытый доступ"
              value={route.isPublic}
              trackColor={{ true: colors.forest }}
              onValueChange={(isPublic) => run(() => api.updateRoute(route.id, { isPublic }))}
            />
          </View>
          <View style={{ gap: space.xs }}>
            <Text style={layout.label}>О чём рассказывать</Text>
            <View style={layout.row}>
              {(['facts', 'legends'] as StoryStyle[]).map((s) => (
                <Chip
                  key={s}
                  label={STORY_STYLE_LABEL[s]}
                  active={route.storyStyle === s}
                  onPress={() => {
                    if (s !== route.storyStyle && !storyProgress) run(() => api.updateRoute(route.id, { storyStyle: s }));
                  }}
                />
              ))}
            </View>
          </View>
          {!storyProgress && otherStyle > 0 ? (
            <Button
              title={`Пересоздать в направлении «${STORY_STYLE_LABEL[route.storyStyle]}» (${otherStyle})`}
              icon="refresh"
              variant="secondary"
              onPress={async () => {
                if (await confirm(`Заменить рассказы (${otherStyle}) новыми в направлении «${STORY_STYLE_LABEL[route.storyStyle]}»?`, 'Пересоздать')) {
                  generateAllStories(route, true);
                }
              }}
            />
          ) : null}
          {storyProgress ? (
            <View style={styles.progress}>
              <ActivityIndicator color={colors.forest} size="small" />
              <Text style={layout.muted}>
                {storyProgress.planning
                  ? 'Готовим рассказы…'
                  : `Создаём рассказы: ${storyProgress.done} из ${storyProgress.total}. Можно закрыть страницу — сервер доделает сам.`}
              </Text>
            </View>
          ) : missingStories > 0 ? (
            <Button
              title={`Создать аудиорассказы (${missingStories})`}
              icon="sparkles"
              variant="secondary"
              onPress={() => generateAllStories(route)}
            />
          ) : null}
          <View style={layout.row}>
            <Button
              title="Добавить место"
              icon="add-circle-outline"
              variant="secondary"
              disabled={!!addMode}
              onPress={() => {
                setEndpointEdit(null);
                setDraft(null);
                setAddMode('near');
              }}
            />
            {route.points.length > 2 ? (
              <Button
                title="Упорядочить автоматически"
                icon="git-network-outline"
                variant="secondary"
                loading={ordering}
                disabled={ordering}
                onPress={async () => {
                  if (await confirm('Расставить точки в самом коротком порядке обхода?', 'Упорядочить')) reorder({ auto: true });
                }}
              />
            ) : null}
          </View>
        </View>
      ) : (
        <RatingBlock route={route} signedIn={!!user} onRate={(v) => run(() => api.rate(route.id, v))} />
      )}

      {route.canEdit ? (
        <EndpointsCard
          route={route}
          editing={endpointEdit}
          onEdit={(t) => {
            if (t) setAddMode(null);
            setEndpointEdit(t);
          }}
          draft={draft}
          onDraft={setDraft}
          onRoute={(r) => {
            setRoute(r);
            setError(null);
          }}
        />
      ) : null}

      {addMode ? (
        <AddPlace
          route={route}
          mode={addMode}
          onModeChange={setAddMode}
          draft={draft}
          onDraft={setDraft}
          onAdded={(res) => {
            setRoute(res.route);
            setSelectedId(res.pointId);
            setInfo('Место добавлено. Порядок можно поменять стрелками у точек.');
          }}
          onClose={closeAdding}
        />
      ) : null}

      {route.points.length === 0 && route.canEdit && !addMode ? (
        <View style={layout.card}>
          <Text style={layout.h2}>В маршруте пока нет мест</Text>
          <Text style={layout.muted}>
            Добавьте первое место: найдите его по названию или адресу, выберите из мест рядом или нажмите на карту. Путь по
            улицам проложится сам, порядок можно поменять стрелками.
          </Text>
        </View>
      ) : null}

      <View style={{ gap: space.md }}>
        {route.points.map((p, i) => (
          <PointCard
            key={p.id}
            index={i}
            point={p}
            route={route}
            ordering={ordering}
            onMove={(dir) => move(i, dir)}
            expanded={selectedId === p.id}
            busyStories={!!storyProgress}
            onToggle={() => setSelectedId(selectedId === p.id ? null : p.id)}
            onRoute={apply}
            onError={setError}
          />
        ))}
      </View>

      {route.isPublic || route.canEdit ? (
        <ShareCard
          route={route}
          onPublish={async () => {
            setError(null);
            try {
              apply(await api.updateRoute(route.id, { isPublic: true }));
              return true;
            } catch (err) {
              setError(message(err));
              return false;
            }
          }}
        />
      ) : null}

      <ExportCard route={route} />

      {route.canEdit ? (
        <Button
          title="Удалить маршрут"
          icon="trash-outline"
          variant="danger"
          onPress={async () => {
            if (!(await confirm(`Удалить маршрут «${route.title}»?`, 'Удалить'))) return;
            try {
              await api.deleteRoute(route.id);
              router.back();
            } catch (err) {
              setError(message(err));
            }
          }}
        />
      ) : null}
      <Text style={styles.attribution}>
        Данные карты © участники OpenStreetMap. Сведения о местах: Википедия (CC BY-SA), Викиданные и реестр объектов
        культурного наследия. Фото: Wikimedia Commons, авторы и лицензии указаны у каждого снимка.
      </Text>
    </ScrollView>
  );

  return (
    <View style={[layout.screen, wide && { flexDirection: 'row' }]}>
      <Stack.Screen options={{ title: 'Маршрут' }} />
      <View style={wide ? { flex: 1 } : { height: Math.min(340, width * 0.85) }}>{map}</View>
      <View style={wide ? { width: 480 } : { flex: 1 }}>{details}</View>
    </View>
  );
}

function RatingBlock({ route, signedIn, onRate }: { route: Route; signedIn: boolean; onRate: (v: number) => void }) {
  return (
    <View style={layout.card}>
      <View style={styles.ratingRow}>
        <Stars value={route.rating.avg ?? 0} />
        <Text style={layout.muted}>
          {route.rating.count > 0
            ? `${String(route.rating.avg).replace('.', ',')} · оценок: ${route.rating.count}`
            : 'Пока без оценок'}
        </Text>
      </View>
      {signedIn ? (
        <View style={{ gap: space.xs, marginTop: space.xs }}>
          <Text style={layout.label}>{route.myRating ? 'Ваша оценка' : 'Оцените маршрут'}</Text>
          <Stars value={route.myRating ?? 0} size={30} onChange={onRate} />
        </View>
      ) : (
        <Pressable role="link" onPress={() => router.navigate('/profile')}>
          <Text style={styles.link}>Войдите, чтобы поставить оценку</Text>
        </Pressable>
      )}
    </View>
  );
}

function PointCard({
  index,
  point,
  route,
  expanded,
  busyStories,
  ordering,
  onMove,
  onToggle,
  onRoute,
  onError,
}: {
  index: number;
  point: RoutePoint;
  route: Route;
  ordering: boolean;
  onMove: (dir: -1 | 1) => void;
  expanded: boolean;
  busyStories: boolean;
  onToggle: () => void;
  onRoute: (res: { route: Route; notices?: string[] }) => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const action = async (name: string, fn: () => Promise<{ route: Route; notices?: string[] }>) => {
    setBusy(name);
    onError(null);
    try {
      onRoute(await fn());
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const pickPhotoOrVideo = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85, // на iOS заодно перекодирует HEIC в JPEG
    });
    const a = res.assets?.[0];
    if (res.canceled || !a) return;
    const isVideo = a.type === 'video';
    const asset: UploadAsset = {
      uri: a.uri,
      name: a.fileName ?? (isVideo ? 'video.mp4' : 'photo.jpg'),
      mimeType: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
      file: a.file,
    };
    await action('upload', () => api.uploadMedia(point.id, asset));
  };

  const pickAudio = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    const a = res.assets?.[0];
    if (res.canceled || !a) return;
    const asset: UploadAsset = {
      uri: a.uri,
      name: a.name,
      mimeType: a.mimeType ?? 'audio/mpeg',
      file: a.file,
    };
    await action('upload', () => api.uploadMedia(point.id, asset));
  };

  return (
    <View style={[styles.point, expanded && styles.pointExpanded]}>
      <View style={styles.pointRow}>
      <Pressable
        role="button"
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.pointHead}
      >
        <View style={[styles.pointNumber, expanded && { backgroundColor: colors.accent }]}>
          <Text style={styles.pointNumberText}>{index + 1}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.pointName}>{point.name}</Text>
          {point.teaser ? (
            <Text style={layout.muted} numberOfLines={expanded ? undefined : 2}>
              {point.teaser}
            </Text>
          ) : null}
        </View>
        {point.photo && !expanded ? (
          <Image source={{ uri: point.photo.url }} style={styles.thumb} resizeMode="cover" aria-hidden />
        ) : null}
        {point.story || point.media.length ? (
          <Ionicons name="headset-outline" size={18} color={colors.forest} aria-label="Есть рассказ или материалы" />
        ) : null}
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} />
      </Pressable>
      {route.canEdit && route.points.length > 1 ? (
        <View style={styles.moveBox}>
          <MoveButton icon="chevron-up" label={`Поднять «${point.name}» выше`} disabled={ordering || index === 0} onPress={() => onMove(-1)} />
          <MoveButton
            icon="chevron-down"
            label={`Опустить «${point.name}» ниже`}
            disabled={ordering || index === route.points.length - 1}
            onPress={() => onMove(1)}
          />
        </View>
      ) : null}
      </View>

      {expanded ? (
        <View style={styles.pointBody}>
          {point.photo ? <CommonsPhoto photo={point.photo} name={point.name} /> : null}
          {point.heritageRef ? (
            <Text style={styles.source}>Объект культурного наследия, номер в реестре ЕГРОКН {point.heritageRef}</Text>
          ) : null}
          {point.story && !editing ? (
            <>
              {point.narrationUrl ? (
                <AudioPlayer url={point.narrationUrl} title="Аудиорассказ" />
              ) : (
                <DeviceVoicePlayer text={point.story} lang={route.lang} title="Аудиорассказ" />
              )}
              {point.storyStyle === 'legends' ? (
                <View style={styles.styleTag}>
                  <Ionicons name="moon-outline" size={14} color={colors.accent} />
                  <Text style={styles.styleTagText}>Мифы и легенды</Text>
                </View>
              ) : null}
              <Text style={layout.body}>{point.story}</Text>
              {point.storyStyle === 'legends' ? (
                <Text style={styles.source}>Легенды и предания — не исторические факты.</Text>
              ) : null}
              {point.storySource ? <Text style={styles.source}>{SOURCE_NOTE[point.storySource]}</Text> : null}
              {point.storySourceUrl ? (
                <Pressable role="link" onPress={() => Linking.openURL(point.storySourceUrl!)}>
                  <Text style={styles.link}>{sourceLinkTitle(point.storySourceUrl)}</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}

          {editing ? (
            <View style={{ gap: space.sm }}>
              <Field label="Текст рассказа" value={draft} onChangeText={setDraft} multiline maxLength={8000} style={{ minHeight: 160, textAlignVertical: 'top' }} />
              <View style={layout.row}>
                <Button
                  title="Сохранить"
                  loading={busy === 'save'}
                  disabled={!draft.trim()}
                  onPress={async () => {
                    await action('save', () => api.updatePoint(point.id, { story: draft }));
                    setEditing(false);
                  }}
                />
                <Button title="Отмена" variant="secondary" onPress={() => setEditing(false)} />
              </View>
            </View>
          ) : null}

          {!point.story && !route.canEdit ? <Text style={layout.muted}>Автор ещё не добавил рассказ.</Text> : null}

          {point.media.map((m) => (
            <MediaItem
              key={m.id}
              media={m}
              owner={route.canEdit}
              onDelete={async () => {
                if (await confirm('Удалить файл?', 'Удалить')) action('media', () => api.deleteMedia(m.id));
              }}
            />
          ))}

          {route.canEdit && !editing ? (
            <View style={styles.actions}>
              <Button
                title={point.story ? `Создать заново: ${STORY_STYLE_LABEL[route.storyStyle].toLowerCase()}` : 'Создать рассказ'}
                icon="sparkles-outline"
                variant="secondary"
                loading={busy === 'story'}
                disabled={!!busy || busyStories}
                onPress={async () => {
                  if (point.story && !(await confirm('Заменить текущий рассказ новым?', 'Заменить'))) return;
                  // «Создать заново» — всегда новый текст, а не готовый рассказ из другого маршрута.
                  action('story', () => api.generateStory(point.id, { style: route.storyStyle, fresh: !!point.story }));
                }}
              />
              <Button
                title={point.story ? 'Править текст' : 'Написать самому'}
                icon="create-outline"
                variant="secondary"
                disabled={!!busy}
                onPress={() => {
                  setDraft(point.story ?? '');
                  setEditing(true);
                }}
              />
              <Button title="Фото или видео" icon="image-outline" variant="secondary" loading={busy === 'upload'} disabled={!!busy} onPress={pickPhotoOrVideo} />
              <Button title="Аудиофайл" icon="musical-notes-outline" variant="secondary" disabled={!!busy} onPress={pickAudio} />
              {route.points.length > 1 ? (
                <Button
                  title="Убрать точку"
                  icon="trash-outline"
                  variant="danger"
                  loading={busy === 'delete'}
                  disabled={!!busy}
                  onPress={async () => {
                    if (await confirm(`Убрать «${point.name}» из маршрута?`, 'Убрать')) action('delete', () => api.deletePoint(point.id));
                  }}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function MoveButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'chevron-up' | 'chevron-down';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.moveButton, disabled && { opacity: 0.3 }, pressed && { backgroundColor: colors.forestSoft }]}
    >
      <Ionicons name={icon} size={20} color={colors.forest} />
    </Pressable>
  );
}

/** Фото с Commons: автор и лицензия обязательны по условиям CC BY и CC BY-SA. */
function CommonsPhoto({ photo, name }: { photo: PlacePhoto; name: string }) {
  const ratio = photo.width && photo.height ? Math.min(Math.max(photo.width / photo.height, 0.75), 2) : 4 / 3;
  const credit = [photo.author, photo.license].filter(Boolean).join(', ');
  return (
    <View style={{ gap: space.xs }}>
      <Image source={{ uri: photo.url }} style={[styles.image, { aspectRatio: ratio }]} resizeMode="cover" aria-label={`Фото: ${name}`} />
      <Pressable role="link" onPress={() => Linking.openURL(photo.page)} hitSlop={4}>
        <Text style={styles.credit}>
          Фото{credit ? `: ${credit}` : ''} · Wikimedia Commons
        </Text>
      </Pressable>
    </View>
  );
}

function MediaItem({ media, owner, onDelete }: { media: Media; owner: boolean; onDelete: () => void }) {
  return (
    <View style={{ gap: space.xs }}>
      {media.kind === 'image' ? (
        <Image source={{ uri: mediaUrl(media.url) }} style={styles.image} resizeMode="cover" aria-label={media.caption || 'Фото точки маршрута'} />
      ) : media.kind === 'video' ? (
        <VideoPlayer url={media.url} />
      ) : (
        <AudioPlayer url={media.url} title={media.caption || 'Аудиозапись автора'} />
      )}
      {media.caption && media.kind !== 'audio' ? <Text style={layout.muted}>{media.caption}</Text> : null}
      {owner ? (
        <Pressable role="button" onPress={onDelete} hitSlop={6}>
          <Text style={[styles.link, { color: colors.accent }]}>Удалить файл</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  details: { padding: space.lg, gap: space.lg },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  publishRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  progress: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  link: { color: colors.forest, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  source: { fontSize: 13, lineHeight: 18, color: colors.muted, fontStyle: 'italic' },
  attribution: { fontSize: 12, lineHeight: 17, color: colors.muted },
  point: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  pointExpanded: { borderColor: colors.accent, borderWidth: 1 },
  pointRow: { flexDirection: 'row', alignItems: 'stretch' },
  pointHead: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: 56 },
  moveBox: { justifyContent: 'center', paddingRight: space.xs, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  moveButton: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  pointNumber: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.forest, alignItems: 'center', justifyContent: 'center' },
  pointNumberText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  pointName: { fontFamily: serif, fontSize: 17, lineHeight: 23, fontWeight: '700', color: colors.ink },
  pointBody: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.md },
  image: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.sm, backgroundColor: colors.line },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.line },
  credit: { fontSize: 12, lineHeight: 16, color: colors.muted, textDecorationLine: 'underline' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  styleTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  styleTagText: { fontSize: 12, fontWeight: '600', color: colors.accent },
});
