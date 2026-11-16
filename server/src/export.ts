/** Маршрут в файлы для навигаторов: GPX (OsmAnd, Organic Maps, Garmin, Komoot) и KML (Google Earth, «Мои карты»). */

export interface ExportRoute {
  title: string;
  description: string;
  roundTrip: boolean;
  start: { lat: number; lng: number; label: string | null };
  finish: { lat: number; lng: number; label: string | null } | null;
  geometry: [number, number][];
  points: { name: string; teaser: string; lat: number; lng: number }[];
}

/** Символы, которых не бывает в XML 1.0: иначе навигатор откажется открыть файл. */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xml(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const coord = (n: number) => n.toFixed(6);

/** Линия по улицам, а если её нет — прямые отрезки между точками. */
function track(r: ExportRoute): [number, number][] {
  if (r.geometry.length > 1) return r.geometry;
  const pts: [number, number][] = [[r.start.lat, r.start.lng], ...r.points.map((p): [number, number] => [p.lat, p.lng])];
  if (r.finish) return [...pts, [r.finish.lat, r.finish.lng]];
  return r.roundTrip ? [...pts, [r.start.lat, r.start.lng]] : pts;
}

export function toGpx(r: ExportRoute): string {
  const wpt = (lat: number, lng: number, name: string, desc = '') =>
    `  <wpt lat="${coord(lat)}" lon="${coord(lng)}"><name>${xml(name)}</name>${desc ? `<desc>${xml(desc)}</desc>` : ''}</wpt>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Для прогулок" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xml(r.title)}</name>${r.description ? `<desc>${xml(r.description)}</desc>` : ''}</metadata>`,
    wpt(r.start.lat, r.start.lng, r.start.label ? `Старт: ${r.start.label.split(',')[0]}` : 'Старт'),
    ...r.points.map((p, i) => wpt(p.lat, p.lng, `${i + 1}. ${p.name}`, p.teaser)),
    ...(r.finish ? [wpt(r.finish.lat, r.finish.lng, r.finish.label ? `Финиш: ${r.finish.label.split(',')[0]}` : 'Финиш')] : []),
    `  <trk><name>${xml(r.title)}</name><trkseg>`,
    ...track(r).map(([lat, lng]) => `    <trkpt lat="${coord(lat)}" lon="${coord(lng)}"/>`),
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
}

export function toKml(r: ExportRoute): string {
  const placemark = (lat: number, lng: number, name: string, desc = '') =>
    `    <Placemark><name>${xml(name)}</name>${desc ? `<description>${xml(desc)}</description>` : ''}<Point><coordinates>${coord(lng)},${coord(lat)}</coordinates></Point></Placemark>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${xml(r.title)}</name>`,
    r.description ? `    <description>${xml(r.description)}</description>` : '',
    '    <Style id="path"><LineStyle><color>ff3e4824</color><width>4</width></LineStyle></Style>',
    placemark(r.start.lat, r.start.lng, 'Старт'),
    ...r.points.map((p, i) => placemark(p.lat, p.lng, `${i + 1}. ${p.name}`, p.teaser)),
    ...(r.finish ? [placemark(r.finish.lat, r.finish.lng, 'Финиш')] : []),
    `    <Placemark><name>${xml(r.title)}</name><styleUrl>#path</styleUrl><LineString><tessellate>1</tessellate><coordinates>`,
    track(r).map(([lat, lng]) => `${coord(lng)},${coord(lat)}`).join(' '),
    '    </coordinates></LineString></Placemark>',
    '  </Document>',
    '</kml>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n') + '\n';
}

/** Имя файла: кириллица идёт через filename*, а латинская копия нужна старым клиентам. */
export function contentDisposition(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'route';
  const ascii = base.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') || 'route';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}
