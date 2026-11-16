import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ExportFormat } from './types';

const TYPES: Record<ExportFormat, { mimeType: string; UTI: string }> = {
  gpx: { mimeType: 'application/gpx+xml', UTI: 'com.topografix.gpx' },
  kml: { mimeType: 'application/vnd.google-earth.kml+xml', UTI: 'com.google.earth.kml' },
};

/** Телефон: файл во временной папке и меню «Поделиться» — оттуда он открывается в OsmAnd, Organic Maps и других. */
export async function saveFile(fileName: string, text: string, format: ExportFormat): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('На этом устройстве нельзя поделиться файлом');
  const file = new File(Paths.cache, fileName.replace(/[\\/]/g, ' '));
  if (file.exists) file.delete();
  file.create();
  await file.write(text);
  await Sharing.shareAsync(file.uri, { ...TYPES[format], dialogTitle: 'Открыть маршрут в навигаторе' });
}
