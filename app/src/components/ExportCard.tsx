import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { googleMapsUrl, GOOGLE_MAX_WAYPOINTS, yandexMapsUrl } from '@/lib/navigators';
import { saveFile } from '@/lib/saveFile';
import { space } from '@/lib/theme';
import type { ExportFormat, Route } from '@/lib/types';
import { Banner, Button, layout } from './ui';

/** Маршрут для навигаторов: файлы GPX и KML и пеший маршрут в Яндекс и Google Картах. */
export function ExportCard({ route }: { route: Route }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const google = googleMapsUrl(route);

  const download = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      const { text, fileName } = await api.exportRoute(route.id, format);
      await saveFile(fileName, text, format);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Не удалось сохранить файл');
    } finally {
      setBusy(null);
    }
  };

  const open = (url: string) => Linking.openURL(url).catch(() => setError('Не удалось открыть карты'));

  return (
    <View style={layout.card}>
      <Text style={layout.h2}>В навигатор</Text>
      <Text style={layout.muted}>
        GPX открывают OsmAnd, Organic Maps, Komoot и часы Garmin, KML — Google Earth и «Мои карты». В файле точки по
        порядку и путь по улицам.
      </Text>
      <View style={[layout.row, { gap: space.sm }]}>
        <Button title="Скачать GPX" icon="download-outline" variant="secondary" loading={busy === 'gpx'} disabled={!!busy} onPress={() => download('gpx')} />
        <Button title="Скачать KML" icon="download-outline" variant="secondary" loading={busy === 'kml'} disabled={!!busy} onPress={() => download('kml')} />
      </View>
      <View style={[layout.row, { gap: space.sm }]}>
        <Button title="Яндекс Карты" icon="navigate-outline" variant="secondary" onPress={() => open(yandexMapsUrl(route))} />
        <Button title="Google Карты" icon="navigate-outline" variant="secondary" onPress={() => open(google.url)} />
      </View>
      {google.truncated ? (
        <Text style={layout.muted}>
          Google Карты покажут только {GOOGLE_MAX_WAYPOINTS} промежуточных точек. Для полного маршрута скачайте GPX.
        </Text>
      ) : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}
