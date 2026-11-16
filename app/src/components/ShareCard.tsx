import { useState } from 'react';
import { Linking, Platform, Share, Text, View } from 'react-native';
import { Button, layout } from '@/components/ui';
import { API_URL } from '@/lib/api';
import { formatDistance, formatDuration, pluralStops } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import type { Route } from '@/lib/types';

/** Адрес веб-версии: на сайте — его собственный, в приложении — тот же домен, что у API. */
function webOrigin(): string {
  if (Platform.OS === 'web' && globalThis.location?.origin) return globalThis.location.origin;
  return (process.env.EXPO_PUBLIC_WEB_URL ?? API_URL).replace(/\/$/, '');
}

export const routeLink = (id: string) => `${webOrigin()}/route/${id}`;

export function shareText(route: Route): string {
  return `${route.title}: пешая аудиоэкскурсия, ${formatDistance(route.distanceM)}, ${formatDuration(route.durationMin)}, ${pluralStops(route.points.length)}`;
}

/** Ссылки «поделиться» мессенджеров: открываются в приложении мессенджера или в браузере. */
export function messengerLinks(url: string, text: string) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return {
    telegram: `https://t.me/share/url?url=${u}&text=${t}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`,
    vk: `https://vk.com/share.php?url=${u}&title=${t}`,
  };
}

export function ShareCard({ route, onPublish }: { route: Route; onPublish: () => Promise<boolean> }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = routeLink(route.id);
  const text = shareText(route);
  const links = messengerLinks(url, text);
  const canWebShare = Platform.OS === 'web' && typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // Приватный маршрут по ссылке не откроется: сначала доступ, потом кнопки мессенджеров.
  // Отдельным шагом, потому что браузер открывает окно мессенджера только сразу после нажатия.
  if (!route.isPublic) {
    return (
      <View style={layout.card}>
        <Text style={layout.h2}>Поделиться</Text>
        <Text style={layout.muted}>
          Маршрут сейчас виден только вам, по ссылке его никто не откроет. Откройте доступ — маршрут появится в каталоге,
          и его можно будет отправить в мессенджер.
        </Text>
        <View style={{ flexDirection: 'row' }}>
          <Button
            title="Открыть доступ"
            icon="lock-open-outline"
            loading={busy}
            onPress={async () => {
              setBusy(true);
              await onPublish();
              setBusy(false);
            }}
          />
        </View>
      </View>
    );
  }

  const systemShare = () => {
    setStatus(null);
    // На iOS ссылка идёт отдельным полем, на Android — внутри текста.
    const shared =
      Platform.OS === 'web'
        ? navigator.share({ title: route.title, text, url })
        : Share.share(Platform.OS === 'ios' ? { message: text, url } : { message: `${text}\n${url}`, title: route.title });
    // Окно закрыли без выбора — это не ошибка.
    shared.catch(() => {});
  };

  const open = (link: string) => {
    Linking.openURL(link).catch(() => setStatus('Не удалось открыть мессенджер'));
  };

  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => setStatus('Ссылка скопирована'),
      () => setStatus(`Скопируйте ссылку вручную: ${url}`),
    );
  };

  return (
    <View style={layout.card}>
      <Text style={layout.h2}>Поделиться</Text>
      <Text style={layout.muted}>
        Отправьте ссылку в мессенджер: откроется карта маршрута с рассказами, приложение ставить не нужно.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {Platform.OS !== 'web' || canWebShare ? <Button title="Поделиться" icon="share-outline" onPress={systemShare} /> : null}
        <Button title="Telegram" icon="paper-plane-outline" variant="secondary" onPress={() => open(links.telegram)} />
        <Button title="WhatsApp" icon="logo-whatsapp" variant="secondary" onPress={() => open(links.whatsapp)} />
        <Button title="ВКонтакте" icon="chatbubbles-outline" variant="secondary" onPress={() => open(links.vk)} />
        {Platform.OS === 'web' ? <Button title="Скопировать ссылку" icon="link-outline" variant="secondary" onPress={copy} /> : null}
      </View>
      {status ? (
        <Text style={{ color: colors.forest, fontSize: 14 }} selectable>
          {status}
        </Text>
      ) : null}
    </View>
  );
}
