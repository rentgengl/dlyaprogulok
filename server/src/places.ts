/**
 * Сведения о местах из проектов Викимедиа:
 * - фото из Wikimedia Commons с автором и лицензией;
 * - факты из Викиданных, в том числе данные реестра объектов культурного наследия (ЕГРОКН);
 * - объекты наследия рядом с точкой — и те, о которых нет статьи в Википедии.
 *
 * Портал открытых данных Минкультуры (opendata.mkrf.ru) недоступен из-за рубежа и с хостинга,
 * поэтому номера реестра и категория охраны берутся из их копии в Викиданных и из тегов OSM.
 */
import type { LatLng } from './geo.ts';
import { haversine } from './geo.ts';

/** Одна строка справки: «Архитектор — Воронихин А. Н.». */
export interface Fact {
  label: string;
  value: string;
}

export interface PlacePhoto {
  /** Уменьшенная копия до 800 px по ширине. */
  url: string;
  width?: number;
  height?: number;
  /** Страница файла на Commons: там полная лицензия и оригинал. */
  page: string;
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
}

/** Объект наследия из Викиданных. */
export interface HeritagePlace extends LatLng {
  wikidata: string;
  name: string;
  about?: string;
  /** Статья в Википедии на языке маршрута, если есть. */
  wikiTitle?: string;
  heritageRef?: string;
  commonsFile?: string;
  /** В скольких разделах Википедии есть статья о месте. */
  sitelinks?: number;
}

type GetJson = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<any>;

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
/** API Викимедиа принимают до 50 названий или id за запрос. */
const BATCH = 50;

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Имя файла без префикса «File:» и подчёркиваний: так его хранят Викиданные и теги OSM. */
export function commonsFileName(raw: string): string | null {
  let name = raw.trim();
  const special = name.match(/Special:FilePath\/(.+)$/i);
  if (special) name = decodeURIComponent(special[1]!);
  name = name.replace(/^(File|Файл|Image):/i, '').replace(/_/g, ' ').trim();
  if (!name || name.startsWith('Category:') || !/\.(jpe?g|png|webp|gif|tiff?)$/i.test(name)) return null;
  return name;
}

/** Текст из HTML-поля Commons: «<a href=…>Иван Петров</a>» → «Иван Петров». */
export function plainText(html: string | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Ссылки Commons приходят с utm-метками: в приложении они не нужны. */
const stripTracking = (url: string) => url.replace(/\?utm_[^#]*$/, '');

/** Фото по именам файлов на Commons; файлы, которых нет, просто пропускаются. */
export async function commonsPhotos(files: string[], getJson: GetJson): Promise<Map<string, PlacePhoto>> {
  const out = new Map<string, PlacePhoto>();
  const unique = [...new Set(files)];
  for (const batch of chunks(unique, BATCH)) {
    const params = new URLSearchParams({
      action: 'query',
      titles: batch.map((f) => `File:${f}`).join('|'),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '800',
      iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
      format: 'json',
      formatversion: '2',
    });
    const data = await getJson(`${COMMONS_API}?${params}`);
    // Commons нормализует названия; ответ нужно сопоставить с тем, что спрашивали.
    const renamed = new Map<string, string>();
    for (const n of data?.query?.normalized ?? []) renamed.set(n.to, n.from);
    for (const page of data?.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!info || page.missing) continue;
      const asked = (renamed.get(page.title) ?? page.title).replace(/^File:/, '');
      const meta = info.extmetadata ?? {};
      const photo: PlacePhoto = {
        url: stripTracking(info.thumburl ?? info.url),
        width: info.thumbwidth,
        height: info.thumbheight,
        page: stripTracking(info.descriptionurl),
        author: plainText(meta.Artist?.value),
        license: plainText(meta.LicenseShortName?.value),
        licenseUrl: meta.LicenseUrl?.value ? String(meta.LicenseUrl.value) : null,
      };
      out.set(commonsFileName(asked) ?? asked, photo);
      out.set(commonsFileName(page.title) ?? page.title, photo);
    }
  }
  return out;
}

export interface PhotoRequest {
  wikiTitle?: string | null;
  wikidata?: string | null;
  commonsFile?: string | null;
}

export interface PhotoResult {
  wikidata: string | null;
  photo: PlacePhoto | null;
}

/**
 * Фото для списка мест за несколько запросов на всех:
 * статья Википедии → её свободная заглавная картинка и id Викиданных;
 * Викиданные → изображение (P18); затем сведения о файлах с Commons.
 */
export async function findPhotos(items: PhotoRequest[], lang: string, wikiHost: string, getJson: GetJson): Promise<PhotoResult[]> {
  const result: PhotoResult[] = items.map((i) => ({ wikidata: i.wikidata ?? null, photo: null }));
  const file: (string | null)[] = items.map((i) => (i.commonsFile ? commonsFileName(i.commonsFile) : null));

  // 1. Статьи: заглавная свободная картинка и элемент Викиданных.
  const titles = [...new Set(items.filter((i, k) => i.wikiTitle && (!file[k] || !i.wikidata)).map((i) => i.wikiTitle!))];
  const byTitle = new Map<string, { wikidata?: string; image?: string }>();
  for (const batch of chunks(titles, BATCH)) {
    const params = new URLSearchParams({
      action: 'query',
      titles: batch.join('|'),
      prop: 'pageprops',
      ppprop: 'wikibase_item|page_image_free',
      redirects: '1',
      format: 'json',
      formatversion: '2',
    });
    const data = await getJson(`https://${wikiHost}/w/api.php?${params}`);
    const alias = new Map<string, string>();
    for (const n of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) alias.set(n.to, n.from);
    for (const page of data?.query?.pages ?? []) {
      const info = { wikidata: page.pageprops?.wikibase_item, image: page.pageprops?.page_image_free };
      byTitle.set(page.title, info);
      // Цепочка «редирект ← нормализация» до исходного названия.
      let from = alias.get(page.title);
      for (let guard = 0; from && guard < 3; guard++) {
        byTitle.set(from, info);
        from = alias.get(from);
      }
    }
  }
  items.forEach((item, k) => {
    const info = item.wikiTitle ? byTitle.get(item.wikiTitle) : undefined;
    if (!info) return;
    result[k]!.wikidata ??= info.wikidata ?? null;
    file[k] ??= info.image ? commonsFileName(info.image) : null;
  });

  // 2. Викиданные: изображение P18 для тех, у кого картинки ещё нет.
  const ids = [...new Set(result.filter((r, k) => r.wikidata && !file[k]).map((r) => r.wikidata!))];
  const p18 = new Map<string, string>();
  for (const batch of chunks(ids, BATCH)) {
    const params = new URLSearchParams({ action: 'wbgetentities', ids: batch.join('|'), props: 'claims', format: 'json' });
    const data = await getJson(`${WIKIDATA_API}?${params}`);
    for (const [id, entity] of Object.entries<any>(data?.entities ?? {})) {
      const name = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (typeof name === 'string') p18.set(id, name);
    }
  }
  result.forEach((r, k) => {
    if (!file[k] && r.wikidata && p18.has(r.wikidata)) file[k] = commonsFileName(p18.get(r.wikidata)!);
  });

  // 3. Commons: ссылка, автор и лицензия.
  const photos = await commonsPhotos(file.filter((f): f is string => !!f), getJson);
  result.forEach((r, k) => {
    r.photo = file[k] ? (photos.get(file[k]!) ?? null) : null;
  });
  return result;
}

/** Свойства Викиданных, которые годятся для справки о месте, в порядке показа. */
const FACT_PROPS: { prop: string; label: string; kind: 'item' | 'time' | 'string' | 'quantity' | 'text' }[] = [
  { prop: 'P31', label: 'Что это', kind: 'item' },
  { prop: 'P361', label: 'Часть', kind: 'item' },
  { prop: 'P571', label: 'Создан', kind: 'time' },
  { prop: 'P1619', label: 'Открыт', kind: 'time' },
  { prop: 'P84', label: 'Архитектор', kind: 'item' },
  { prop: 'P170', label: 'Автор', kind: 'item' },
  { prop: 'P149', label: 'Стиль', kind: 'item' },
  { prop: 'P186', label: 'Материал', kind: 'item' },
  { prop: 'P140', label: 'Конфессия', kind: 'item' },
  { prop: 'P138', label: 'Назван в честь', kind: 'item' },
  { prop: 'P547', label: 'Посвящён', kind: 'item' },
  { prop: 'P2048', label: 'Высота, м', kind: 'quantity' },
  { prop: 'P1435', label: 'Охранный статус', kind: 'item' },
  { prop: 'P5381', label: 'Номер в реестре ЕГРОКН', kind: 'string' },
  { prop: 'P6375', label: 'Адрес', kind: 'text' },
  { prop: 'P576', label: 'Утрачен', kind: 'time' },
];

const MAX_VALUES = 4;

/** «+1801-00-00T00:00:00Z», точность 9 → «1801»; 8 → «1800-е»; 7 → «XIX век». */
export function formatWikidataTime(value: { time: string; precision: number }): string | null {
  const m = value.time.match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
  if (!m) return null;
  const year = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  if (year <= 0) return null;
  if (value.precision >= 11) return `${Number(m[4])}.${m[3]}.${year}`;
  if (value.precision >= 9) return String(year);
  if (value.precision === 8) return `${Math.floor(year / 10) * 10}-е`;
  if (value.precision === 7) return `${roman(Math.floor((year - 1) / 100) + 1)} век`;
  return null;
}

function roman(n: number): string {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

export interface WikidataFacts {
  label: string | null;
  description: string | null;
  facts: Fact[];
  url: string;
}

/** Справка о месте по элементу Викиданных: два запроса — сам элемент и подписи связанных. */
export async function wikidataFacts(id: string, lang: string, getJson: GetJson): Promise<WikidataFacts | null> {
  if (!/^Q\d+$/.test(id)) return null;
  const langs = lang === 'ru' ? 'ru' : `${lang}|ru`;
  const params = new URLSearchParams({ action: 'wbgetentities', ids: id, props: 'claims|labels|descriptions', languages: langs, format: 'json' });
  const data = await getJson(`${WIKIDATA_API}?${params}`);
  const entity = data?.entities?.[id];
  if (!entity || entity.missing !== undefined) return null;
  const pick = (map: any) => map?.[lang]?.value ?? map?.ru?.value ?? null;

  const raw: { label: string; kind: string; values: any[] }[] = [];
  const linked = new Set<string>();
  for (const f of FACT_PROPS) {
    const statements = (entity.claims?.[f.prop] ?? []).filter((s: any) => s.rank !== 'deprecated' && s.mainsnak?.datavalue);
    const preferred = statements.filter((s: any) => s.rank === 'preferred');
    const values = (preferred.length ? preferred : statements).slice(0, MAX_VALUES).map((s: any) => s.mainsnak.datavalue.value);
    if (!values.length) continue;
    if (f.kind === 'item') values.forEach((v: any) => v?.id && linked.add(v.id));
    raw.push({ label: f.label, kind: f.kind, values });
  }

  const names = new Map<string, string>();
  for (const batch of chunks([...linked], BATCH)) {
    const p = new URLSearchParams({ action: 'wbgetentities', ids: batch.join('|'), props: 'labels', languages: langs, format: 'json' });
    const res = await getJson(`${WIKIDATA_API}?${p}`);
    for (const [qid, e] of Object.entries<any>(res?.entities ?? {})) {
      const name = pick(e?.labels);
      if (name) names.set(qid, name);
    }
  }

  const facts: Fact[] = [];
  for (const r of raw) {
    const values = r.values
      .map((v: any) => {
        if (r.kind === 'item') return names.get(v?.id) ?? null;
        if (r.kind === 'time') return formatWikidataTime(v);
        if (r.kind === 'quantity') return v?.amount ? String(Number(v.amount)) : null;
        if (r.kind === 'text') return typeof v?.text === 'string' ? v.text : null;
        return typeof v === 'string' ? v : null;
      })
      .filter((v: string | null): v is string => !!v);
    if (values.length) facts.push({ label: r.label, value: [...new Set(values)].join(', ') });
  }
  return { label: pick(entity.labels), description: pick(entity.descriptions), facts, url: `https://www.wikidata.org/wiki/${id}` };
}

/** Факты из тегов OSM: у многих зданий в России есть номер реестра и год постройки. */
export function osmFacts(tags: Record<string, string>): Fact[] {
  const facts: Fact[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) facts.push({ label, value: value.trim().slice(0, 200) });
  };
  add('Описание', tags['description:ru'] ?? tags.description);
  add('Создан', tags.start_date);
  add('Архитектор', tags.architect);
  add('Автор', tags.artist_name);
  add('Посвящён', tags.memorial ? tags['memorial:subject'] ?? tags.subject : tags.subject);
  add('Номер в реестре ЕГРОКН', tags['ref:okn']);
  if (tags['ref:okn'] || tags.heritage) add('Охранный статус', 'объект культурного наследия');
  const street = tags['addr:street'];
  if (street) add('Адрес', [street, tags['addr:housenumber']].filter(Boolean).join(', '));
  return facts;
}

/** Справки из разных источников без повторов: первый источник важнее. */
export function mergeFacts(...lists: (Fact[] | null | undefined)[]): Fact[] {
  const out: Fact[] = [];
  for (const list of lists) {
    for (const f of list ?? []) {
      // «Охранный статус» из OSM общий, а из Викиданных точный: оставляем первый.
      if (out.some((o) => o.label === f.label)) continue;
      out.push(f);
    }
  }
  return out;
}

/** Справка как источник для рассказа: «Архитектор: …». */
export function factsSource(name: string, description: string | null, facts: Fact[]): string {
  return [`Название: ${name}`, ...(description ? [`Описание: ${description}`] : []), ...facts.map((f) => `${f.label}: ${f.value}`)].join('\n');
}

/** Рассказ без ИИ: короткие фразы по справке. */
export function factsStory(name: string, description: string | null, facts: Fact[]): string {
  const get = (label: string) => facts.find((f) => f.label === label)?.value;
  const parts: string[] = [];
  const what = description ?? get('Что это');
  parts.push(what ? `${name} — ${what}.` : `${name}.`);
  const created = get('Создан') ?? get('Открыт');
  if (created) parts.push(`Время создания: ${created}.`);
  const author = get('Архитектор') ?? get('Автор');
  if (author) parts.push(`${get('Архитектор') ? 'Архитектор' : 'Автор'} — ${author}.`);
  const style = get('Стиль');
  if (style) parts.push(`Стиль: ${style}.`);
  const dedicated = get('Посвящён') ?? get('Назван в честь');
  if (dedicated) parts.push(`Посвящён: ${dedicated}.`);
  const status = get('Охранный статус');
  if (status) {
    const ref = get('Номер в реестре ЕГРОКН');
    parts.push(`Охраняется государством: ${status}${ref ? `, номер в реестре ${ref}` : ''}.`);
  }
  const lost = get('Утрачен');
  if (lost) parts.push(`Утрачен: ${lost}.`);
  return parts.join(' ');
}

/** Сколько ждать сервис запросов Викиданных: он бывает медленным, а без него маршрут всё равно строится. */
const SPARQL_TIMEOUT_MS = 12_000;

/**
 * Объекты культурного наследия рядом: у элемента есть номер ЕГРОКН (P5381) или kulturnoe-nasledie.ru (P1483).
 * В центре большого города их тысячи, поэтому берутся 300 ближайших.
 */
export async function heritageNearby(center: LatLng, radiusM: number, lang: string, getJson: GetJson): Promise<HeritagePlace[]> {
  const km = (Math.min(radiusM, 5000) / 1000).toFixed(2);
  const l = /^[a-z]{2}$/.test(lang) ? lang : 'ru';
  const query = `SELECT ?item (SAMPLE(?label) AS ?name) (SAMPLE(?desc) AS ?about) (SAMPLE(?partLabel) AS ?part)
  (SAMPLE(?coord) AS ?c) (SAMPLE(?img) AS ?image) (SAMPLE(?eg) AS ?egrokn) (SAMPLE(?title) AS ?wiki) (MIN(?d) AS ?dist) WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${center.lng} ${center.lat})"^^geo:wktLiteral. bd:serviceParam wikibase:radius "${km}". bd:serviceParam wikibase:distance ?d. }
  { ?item wdt:P5381 ?eg } UNION { ?item wdt:P1483 [] }
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  ?item rdfs:label ?label FILTER(LANG(?label) IN ("${l}", "ru"))
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "${l}") }
  OPTIONAL { ?item wdt:P361 ?partOf. ?partOf rdfs:label ?partLabel FILTER(LANG(?partLabel) = "${l}") }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://${l}.wikipedia.org/>; schema:name ?title }
} GROUP BY ?item ORDER BY ?dist LIMIT 300`;
  return sparqlPlaces(query, center, radiusM, getJson);
}

/** Строки ответа SPARQL с полями item, name, about, part, c, image, egrokn, wiki, links → места. */
async function sparqlPlaces(query: string, center: LatLng, radiusM: number, getJson: GetJson): Promise<HeritagePlace[]> {
  const params = new URLSearchParams({ query, format: 'json' });
  const data = await getJson(`${SPARQL}?${params}`, {
    headers: { Accept: 'application/sparql-results+json' },
    timeoutMs: SPARQL_TIMEOUT_MS,
  });
  const out: HeritagePlace[] = [];
  for (const row of data?.results?.bindings ?? []) {
    const m = String(row.c?.value ?? '').match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    const id = String(row.item?.value ?? '').split('/').pop();
    const label = row.name?.value;
    if (!m || !id || !label) continue;
    const point = { lat: Number(m[2]), lng: Number(m[1]) };
    if (haversine(center, point) > radiusM) continue;
    const part = row.part?.value;
    // У частей ансамблей названия бывают общими: «Собор», «Фонтан».
    const generic = label.trim().split(/\s+/).length <= 2 && part && !label.includes(part);
    const links = Number(row.links?.value);
    out.push({
      wikidata: id,
      name: generic ? `${label} (${part})` : label,
      ...point,
      about: row.about?.value,
      wikiTitle: row.wiki?.value,
      heritageRef: row.egrokn?.value,
      commonsFile: row.image?.value ? (commonsFileName(row.image.value) ?? undefined) : undefined,
      ...(Number.isFinite(links) ? { sitelinks: links } : {}),
    });
  }
  return out;
}

/**
 * Что не годится в остановку прогулки, хотя у него есть координаты и статьи:
 * люди, населённые пункты и районы, улицы и дороги, станции и остановки, транспортные системы, реки,
 * организации, картины (у музейных картин есть координаты музея).
 */
const NOT_STOP_CLASSES = [
  'Q5', 'Q486972', 'Q515', 'Q532', 'Q3957', 'Q1549591', 'Q123705', 'Q2983893', 'Q1149652', 'Q79007', 'Q34442',
  'Q55488', 'Q928830', 'Q953806', 'Q2175765', 'Q4022', 'Q43229', 'Q4830453', 'Q3914', 'Q1248784', 'Q3917681', 'Q5503', 'Q3305213', 'Q93184',
];
/** Сколько разделов Википедии должно писать о месте, чтобы считать его заметным. */
const MIN_SITELINKS = 2;

/**
 * Заметные места рядом по Викиданным: о них есть статьи хотя бы в MIN_SITELINKS разделах Википедии.
 * Так находятся места, о которых нет статьи на языке маршрута, но есть на других, и которых нет в OSM.
 */
export async function notableNearby(center: LatLng, radiusM: number, lang: string, getJson: GetJson): Promise<HeritagePlace[]> {
  const km = (Math.min(radiusM, 5000) / 1000).toFixed(2);
  const l = /^[a-z]{2}$/.test(lang) ? lang : 'ru';
  const query = `SELECT ?item (SAMPLE(?label) AS ?name) (SAMPLE(?desc) AS ?about) (SAMPLE(?coord) AS ?c) (SAMPLE(?img) AS ?image)
  (SAMPLE(?title) AS ?wiki) (MAX(?sl) AS ?links) (MIN(?d) AS ?dist) WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${center.lng} ${center.lat})"^^geo:wktLiteral. bd:serviceParam wikibase:radius "${km}". bd:serviceParam wikibase:distance ?d. }
  ?item wikibase:sitelinks ?sl FILTER(?sl >= ${MIN_SITELINKS})
  FILTER NOT EXISTS { ?item wdt:P31 ?cls VALUES ?cls { ${NOT_STOP_CLASSES.map((q) => `wd:${q}`).join(' ')} } }
  FILTER NOT EXISTS { ?item wdt:P1082 [] }
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  FILTER NOT EXISTS { ?item wdt:P585 [] }
  FILTER NOT EXISTS { ?item wdt:P580 [] }
  FILTER NOT EXISTS { ?item wdt:P710 [] }
  ?item rdfs:label ?label FILTER(LANG(?label) IN ("${l}", "ru"))
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "${l}") }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://${l}.wikipedia.org/>; schema:name ?title }
} GROUP BY ?item ORDER BY DESC(?links) LIMIT 200`;
  return sparqlPlaces(query, center, radiusM, getJson);
}
