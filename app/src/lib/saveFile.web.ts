import type { ExportFormat } from './types';

const MIME: Record<ExportFormat, string> = {
  gpx: 'application/gpx+xml',
  kml: 'application/vnd.google-earth.kml+xml',
};

/** Веб: обычное скачивание файла браузером. */
export async function saveFile(fileName: string, text: string, format: ExportFormat): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: MIME[format] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Браузеру нужно время начать скачивание до освобождения ссылки.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
