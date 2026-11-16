/** Внешние сервисы: OSM Overpass, Википедия, Викиданные, Commons, OSRM, Nominatim. */
import type { LatLng } from './geo.ts';
import { haversine, pathLength, WALK_DETOUR_FACTOR } from './geo.ts';
import {
  findPhotos,
  heritageNearby,
  notableNearby,
  osmFacts,
  wikidataFacts,
  type Fact,
  type HeritagePlace,
  type PhotoRequest,
  type PhotoResult,
  type WikidataFacts,
} from './places.ts';

/** Викимедиа просит указывать в User-Agent, как связаться с автором клиента. */
const USER_AGENT = 'DlyaProgulok/0.1 (https://dlyaprogulok.ru)';

export interface Candidate extends LatLng {
  id: string;
  name: string;
  kind: string;
  /** Заголовок статьи Википедии на языке маршрута. */
  wikiTitle?: string;
  distanceFromStart: number;
  /** Короткое описание из Википедии. */
  about?: string;
  /** Длина статьи: неплохой признак известности места. */
  articleLength?: number;
  hasImage?: boolean;
  /** false: по категориям статьи это не место, а событие, организация и т. п. */
  isPlace?: boolean;
  /** Элемент Викиданных (Q…): по нему ищутся фото и справка. */
  wikidata?: string;
  /** Номер в реестре объектов культурного наследия (ЕГРОКН). */
  heritageRef?: string;
  /** Файл на Wikimedia Commons из тегов OSM или Викиданных. */
  commonsFile?: string;
  /** Справка из тегов OSM. */
  facts?: Fact[];
  /** В скольких разделах Википедии есть статья о месте: признак известности, когда своей статьи нет. */
  sitelinks?: number;
}

export interface WalkPath {
  distanceM: number;
  /** [lat, lng][] */
  geometry: [number, number][];
  /** false — сервис маршрутизации недоступен, линия прямая, а длина оценочная. */
  routed: boolean;
}

export interface GeoServices {
  findCandidates(center: LatLng, radius: number, lang: string): Promise<Candidate[]>;
  walkPath(start: LatLng, stops: LatLng[], roundTrip: boolean): Promise<WalkPath>;
  /** near — сначала показать результаты рядом с выбранным городом. */
  geocode(query: string, lang: string, near?: LatLng): Promise<{ name: string; lat: number; lng: number }[]>;
  /** Город, в котором лежит точка; null, если определить не удалось. */
  reverseCity(point: LatLng, lang: string): Promise<string | null>;
  searchCities(query: string, lang: string): Promise<CityResult[]>;
  /** legends: вступление статьи и её разделы о легендах, иначе — начало статьи. */
  wikiExtract(title: string, lang: string, focus?: 'facts' | 'legends'): Promise<WikiExtract | null>;
  /** Статья об объекте без привязки: ищется рядом с точкой, название должно совпасть. */
  findArticle(name: string, near: LatLng, lang: string): Promise<string | null>;
  /** Фото с Commons и id Викиданных для списка мест; ошибки отдельных мест не мешают остальным. */
  placePhotos(items: PhotoRequest[], lang: string): Promise<PhotoResult[]>;
  /** Справка о месте из Викиданных, включая данные реестра наследия. */
  placeFacts(wikidata: string, lang: string): Promise<WikidataFacts | null>;
  /** Самая подробная статья о месте в другом разделе Википедии (не на языке маршрута). */
  otherArticle(wikidata: string, lang: string, focus?: 'facts' | 'legends'): Promise<OtherArticle | null>;
}

export interface CityResult extends LatLng {
  name: string;
  /** Область и страна: чтобы отличить Кировск в Мурманской области от ленинградского. */
  region: string;
}

export interface WikiExtract {
  text: string;
  url: string;
  /** Для focus = legends: нашлись ли в статье разделы о легендах. */
  hasLegends?: boolean;
  /** Элемент Викиданных статьи: по нему находятся статьи на других языках и справка. */
  wikidata?: string;
}

/** Статья на другом языке: lang — код раздела Википедии. */
export interface OtherArticle extends WikiExtract {
  lang: string;
}

/** Заголовки разделов о легендах на языках приложения. */
const LEGEND_HEADING = /легенд|предани|миф|поверь|суевер|примет|мистик|призрак|legend|myth|folklore|sage|leggend|leyend|mito/i;

/** Разделы статьи о легендах: заголовок «== … ==» и текст до следующего заголовка того же уровня или выше. */
export function legendSections(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let current: { level: number; lines: string[] } | null = null;
  for (const line of lines) {
    const h = line.match(/^(={2,})\s*(.+?)\s*\1\s*$/);
    if (h) {
      const level = h[1]!.length;
      if (current && level <= current.level) {
        out.push(current.lines.join('\n').trim());
        current = null;
      }
      if (!current && LEGEND_HEADING.test(h[2]!)) current = { level, lines: [line] };
      else if (current) current.lines.push(line);
      continue;
    }
    current?.lines.push(line);
  }
  if (current) out.push(current.lines.join('\n').trim());
  return out.filter((s) => s.split('\n').slice(1).join('').trim().length > 0);
}

const LEGENDS_INTRO_CHARS = 5000;
const LEGENDS_TOTAL_CHARS = 16000;
/** Сколько статьи отдавать ИИ: рассказ на 250–450 слов нужно из чего-то собрать. */
export const ARTICLE_CHARS = 12000;

/** Источник для рассказа о легендах: короткое вступление и все разделы о легендах. */
export function legendsSource(full: string): { text: string; hasLegends: boolean } {
  const intro = full.split(/\n==/)[0]!.slice(0, LEGENDS_INTRO_CHARS);
  const sections = legendSections(full);
  if (sections.length === 0) return { text: full.slice(0, ARTICLE_CHARS), hasLegends: false };
  return { text: [intro, ...sections].join('\n\n').slice(0, LEGENDS_TOTAL_CHARS), hasLegends: true };
}

/** Начало статьи до ARTICLE_CHARS знаков, по границе абзаца. */
export function articleStart(full: string): string {
  if (full.length <= ARTICLE_CHARS) return full.trim();
  const cut = full.slice(0, ARTICLE_CHARS);
  const end = cut.lastIndexOf('\n');
  return (end > ARTICLE_CHARS / 2 ? cut.slice(0, end) : cut).trim();
}

export async function getJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const { timeoutMs = 10_000, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...rest.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ответил ${res.status}`);
  return res.json();
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const OVERPASS_GRACE_MS = 4_000;

const OVERPASS_FILTERS = [
  '["tourism"~"^(attraction|museum|artwork|gallery|viewpoint)$"]',
  '["historic"]["historic"!~"^(boundary_stone|milestone|wayside_cross|wayside_shrine)$"]',
  '["amenity"~"^(place_of_worship|theatre|fountain|planetarium|arts_centre)$"]["name"]',
  '["leisure"~"^(park|garden)$"]["name"]',
  '["man_made"~"^(lighthouse|tower|water_tower|obelisk|bridge)$"]["name"]',
  // Здания и сооружения со статьёй: у известных зданий нет других тегов достопримечательности.
  '["building"]["name"]["wikidata"]',
];

/** Выбирает название на языке маршрута; объекты без названия для рассказа бесполезны. */
function parseOverpass(data: any, center: LatLng, lang: string): Candidate[] {
  const out: Candidate[] = [];
  for (const el of data?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const tags = el.tags ?? {};
    const name = tags[`name:${lang}`] ?? tags.name;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) continue;
    const wiki = typeof tags.wikipedia === 'string' ? tags.wikipedia : '';
    const wikiTitle = wiki.startsWith(`${lang}:`) ? wiki.slice(lang.length + 1) : undefined;
    const facts = osmFacts(tags);
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name,
      lat,
      lng,
      kind: tags.tourism ?? tags.historic ?? tags.amenity ?? tags.leisure ?? tags.man_made ?? (tags.building ? 'building' : 'place'),
      wikiTitle,
      distanceFromStart: Math.round(haversine(center, { lat, lng })),
      wikidata: /^Q\d+$/.test(tags.wikidata ?? '') ? tags.wikidata : undefined,
      heritageRef: tags['ref:okn'] || undefined,
      commonsFile: tags.wikimedia_commons?.startsWith('File:') ? tags.wikimedia_commons : undefined,
      facts: facts.length ? facts : undefined,
    });
  }
  return out;
}

async function overpassCandidates(center: LatLng, radius: number, lang: string): Promise<Candidate[]> {
  const around = `(around:${radius},${center.lat},${center.lng})`;
  const body = OVERPASS_FILTERS.map((f) => `nwr${f}${around};`).join('');
  const query = `[out:json][timeout:12];(${body});out center 300;`;
  // Промисы гоняются: первое успешное зеркало выигрывает, таймаут не копится.
  const data = await Promise.any(
    OVERPASS_MIRRORS.map((url) =>
      getJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
        timeoutMs: 14_000,
      }),
    ),
  );
  // При перегрузке Overpass отвечает 200 с пустым списком и пометкой remark: это сбой, а не «ничего нет».
  if (typeof data?.remark === 'string' && /error|timed out|timeout/i.test(data.remark)) {
    throw new Error(`Overpass: ${data.remark.slice(0, 120)}`);
  }
  return parseOverpass(data, center, lang);
}

/** Категории статей о том, что можно увидеть своими глазами. */
const PLACE_CATEGORY =
  /здани|сооружен|памятник|монумент|скульптур|храм|собор|церк|часовн|монастыр|мечет|синагог|музе|галере|башн|ворот|стен|кремл|площад|парк|сад|сквер|набережн|мост|дворец|замок|крепост|театр|усадьб|особняк|фонтан|некропол|кладбищ|архитектур|культурного наследия|достопримечательн/i;
const NOT_PLACE_CATEGORY = /парад|событи|организац|компани|предприят|персонал|родивш|умерш|съезд|конференц|органы|правительств|фильм|сражени/i;

/** Страниц в ответе может не хватить на все категории, поэтому продолжение дочитывается. */
const MAX_WIKI_BATCHES = 5;

async function wikipediaCandidates(center: LatLng, radius: number, lang: string): Promise<Candidate[]> {
  const pages = new Map<number, any>();
  let cont: Record<string, string> = {};
  for (let i = 0; i < MAX_WIKI_BATCHES; i++) {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'geosearch',
      ggscoord: `${center.lat}|${center.lng}`,
      ggsradius: String(Math.min(radius, 10_000)),
      ggslimit: '100',
      prop: 'coordinates|info|pageimages|description|categories|pageprops',
      ppprop: 'wikibase_item',
      colimit: 'max',
      piprop: 'name',
      pilimit: 'max',
      cllimit: 'max',
      clshow: '!hidden',
      format: 'json',
      formatversion: '2',
      ...cont,
    });
    const data = await getJson(`https://${wikiHost(lang)}/w/api.php?${params}`);
    for (const p of data?.query?.pages ?? []) {
      const known = pages.get(p.pageid);
      if (known) known.categories = [...(known.categories ?? []), ...(p.categories ?? [])];
      else pages.set(p.pageid, p);
    }
    if (!data?.continue) break;
    cont = data.continue;
  }

  const out: Candidate[] = [];
  for (const p of pages.values()) {
    const coord = p.coordinates?.[0];
    if (!coord) continue;
    const point = { lat: coord.lat as number, lng: coord.lon as number };
    const cats = (p.categories ?? []).map((c: any) => String(c.title)).join(' | ');
    out.push({
      id: `wiki:${p.pageid}`,
      name: p.title,
      ...point,
      kind: 'wikipedia',
      wikiTitle: p.title,
      distanceFromStart: Math.round(haversine(center, point)),
      about: p.description || undefined,
      articleLength: p.length,
      hasImage: !!p.pageimage,
      isPlace: PLACE_CATEGORY.test(cats) && !NOT_PLACE_CATEGORY.test(cats),
      wikidata: p.pageprops?.wikibase_item,
    });
  }
  return out;
}

/**
 * Места из Викиданных как кандидаты: объекты реестра наследия (kind = heritage) и заметные места
 * со статьями в нескольких разделах Википедии (kind = wikidata). С ними приходят места без статьи на языке маршрута.
 */
export function heritageCandidates(places: HeritagePlace[], center: LatLng, kind: 'heritage' | 'wikidata' = 'heritage'): Candidate[] {
  return places.map((h) => ({
    id: `wd:${h.wikidata}`,
    name: h.name,
    lat: h.lat,
    lng: h.lng,
    kind,
    wikiTitle: h.wikiTitle,
    distanceFromStart: Math.round(haversine(center, h)),
    about: h.about ?? (kind === 'heritage' ? 'объект культурного наследия' : undefined),
    sitelinks: h.sitelinks,
    hasImage: !!h.commonsFile,
    wikidata: h.wikidata,
    heritageRef: h.heritageRef,
    commonsFile: h.commonsFile,
  }));
}

/** Разделы Википедии, из которых берутся статьи на других языках, по убыванию подробности. */
const OTHER_WIKIS = ['en', 'ru', 'de', 'fr', 'it', 'es'];

/** Узкий список: lang попадает в hostname, поэтому произвольные значения недопустимы. */
const WIKI_LANGS = new Set(['ru', 'en', 'de', 'fr', 'es', 'it']);
function wikiHost(lang: string): string {
  return `${WIKI_LANGS.has(lang) ? lang : 'ru'}.wikipedia.org`;
}

/** Nominatim кладёт населённый пункт в разные поля в зависимости от его размера. */
export function cityFromAddress(a: any): string | undefined {
  return a?.city ?? a?.town ?? a?.village ?? a?.hamlet ?? a?.municipality ?? undefined;
}

export const normalize = (s: string) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'().,-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Название совпадает, допускается уточнение в скобках: «Мавзолей (Москва)». */
export function sameTitle(name: string, title: string): boolean {
  const bare = title.replace(/\s*\(.*\)\s*$/, '');
  return normalize(name) === normalize(bare);
}

/** Один объект часто есть в обоих источниках. Оставляем запись OSM, дописывая статью из вики. */
export function mergeCandidates(osm: Candidate[], wiki: Candidate[], heritage: Candidate[] = []): Candidate[] {
  const merged = [...osm];
  for (const w of [...wiki, ...heritage]) {
    const twin = merged.find(
      (m) =>
        (m.wikidata && m.wikidata === w.wikidata) ||
        (m.wikiTitle && w.wikiTitle && normalize(m.wikiTitle) === normalize(w.wikiTitle)) ||
        (m.wikiTitle && normalize(m.wikiTitle) === normalize(w.name)) ||
        (normalize(m.name) === normalize(w.name) && haversine(m, w) < 300) ||
        haversine(m, w) < 25,
    );
    if (twin) {
      // Объект есть на карте, значит это точно место: isPlace из вики не переносим.
      twin.wikiTitle ??= w.wikiTitle;
      twin.about ??= w.about;
      twin.articleLength ??= w.articleLength;
      twin.hasImage ??= w.hasImage;
      twin.wikidata ??= w.wikidata;
      twin.heritageRef ??= w.heritageRef;
      twin.commonsFile ??= w.commonsFile;
      twin.sitelinks ??= w.sitelinks;
    } else merged.push(w);
  }
  return merged;
}

export const realGeoServices: GeoServices = {
  async findCandidates(center, radius, lang) {
    const osmRequest = overpassCandidates(center, radius, lang);
    // Реестр наследия из Викиданных — дополнение: при его сбое маршрут строится без него.
    const heritageRequest = heritageNearby(center, radius, lang, getJson).then(
      (places) => heritageCandidates(places, center),
      () => [] as Candidate[],
    );
    // Заметные места из Викиданных — тоже дополнение: места со статьями только на других языках.
    const notableRequest = notableNearby(center, radius, lang, getJson).then(
      (places) => heritageCandidates(places, center, 'wikidata'),
      () => [] as Candidate[],
    );
    // Википедия — главный источник; разовый сбой сети не должен оставлять без маршрута.
    const [wiki] = await Promise.allSettled([
      wikipediaCandidates(center, radius, lang).catch(() => wikipediaCandidates(center, radius, lang)),
    ]);
    // Overpass часто перегружен. Если Википедия уже ответила, ждём его недолго.
    const osmDeadline =
      wiki.status === 'fulfilled' && wiki.value.length > 0
        ? AbortSignal.timeout(OVERPASS_GRACE_MS)
        : undefined;
    const [osm] = await Promise.allSettled([
      osmDeadline
        ? Promise.race([
            osmRequest,
            new Promise<never>((_, reject) => {
              osmDeadline.addEventListener('abort', () => reject(new Error('Overpass не успел')));
            }),
          ])
        : osmRequest,
    ]);
    // Пустой Overpass без Википедии ничего не доказывает: это сбой, а не «рядом ничего нет».
    const osmEmpty = osm.status === 'rejected' || osm.value.length === 0;
    if (wiki.status === 'rejected' && osmEmpty) {
      throw new Error('Источники достопримечательностей недоступны');
    }
    const late = (request: Promise<Candidate[]>) =>
      Promise.race([
        request,
        new Promise<Candidate[]>((resolve) => setTimeout(() => resolve([]), OVERPASS_GRACE_MS).unref()),
      ]);
    const [heritage, notable] = await Promise.all([late(heritageRequest), late(notableRequest)]);
    return mergeCandidates(
      osm.status === 'fulfilled' ? osm.value : [],
      wiki.status === 'fulfilled' ? wiki.value : [],
      [...heritage, ...notable],
    );
  },

  async walkPath(start, stops, roundTrip) {
    const pts = roundTrip ? [start, ...stops, start] : [start, ...stops];
    const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
    try {
      const data = await getJson(
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`,
        { timeoutMs: 15_000 },
      );
      const route = data?.routes?.[0];
      if (!route) throw new Error('маршрут не найден');
      return {
        distanceM: Math.round(route.distance),
        geometry: route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]),
        routed: true,
      };
    } catch {
      return {
        distanceM: Math.round(pathLength(start, stops, roundTrip) * WALK_DETOUR_FACTOR),
        geometry: pts.map((p) => [p.lat, p.lng]),
        routed: false,
      };
    }
  },

  async geocode(query, lang, near) {
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': lang });
    if (near) {
      // Окно около 50 км: результаты внутри идут первыми, но и другие города не отсекаются.
      const d = 0.25;
      params.set('viewbox', `${near.lng - d * 2},${near.lat + d},${near.lng + d * 2},${near.lat - d}`);
      params.set('bounded', '0');
    }
    const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
    return data.map((r: any) => ({
      name: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
    }));
  },

  async reverseCity(point, lang) {
    const params = new URLSearchParams({
      lat: String(point.lat),
      lon: String(point.lng),
      format: 'jsonv2',
      zoom: '10',
      'accept-language': lang,
    });
    const data = await getJson(`https://nominatim.openstreetmap.org/reverse?${params}`);
    return cityFromAddress(data?.address) ?? null;
  },

  async searchCities(query, lang) {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      featureType: 'settlement',
      addressdetails: '1',
      limit: '8',
      'accept-language': lang,
    });
    const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
    const out: CityResult[] = [];
    for (const r of data ?? []) {
      const name = cityFromAddress(r.address) ?? r.name;
      if (!name) continue;
      const region = [r.address?.state, r.address?.country].filter((x) => x && x !== name).join(', ');
      if (out.some((c) => c.name === name && c.region === region)) continue;
      out.push({ name, region, lat: Number(r.lat), lng: Number(r.lon) });
    }
    return out;
  },

  async findArticle(name, near, lang) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'geosearch',
      gscoord: `${near.lat}|${near.lng}`,
      gsradius: '300',
      gslimit: '50',
      format: 'json',
    });
    const data = await getJson(`https://${wikiHost(lang)}/w/api.php?${params}`);
    const hit = (data?.query?.geosearch ?? []).find((p: any) => sameTitle(name, p.title));
    return hit?.title ?? null;
  },

  async placePhotos(items, lang) {
    return findPhotos(items, lang, wikiHost(lang), (url, init) => getJson(url, { timeoutMs: 8_000, ...init }));
  },

  async placeFacts(wikidata, lang) {
    return wikidataFacts(wikidata, lang, getJson);
  },

  async wikiExtract(title, lang, focus = 'facts') {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'extracts|info|pageprops',
      ppprop: 'wikibase_item',
      explaintext: '1',
      // Статья берётся целиком и обрезается здесь: exchars у Википедии не больше 1200 знаков,
      // а легенды обычно в конце статьи.
      inprop: 'url',
      redirects: '1',
      titles: title,
      format: 'json',
    });
    const data = await getJson(`https://${wikiHost(lang)}/w/api.php?${params}`);
    const page: any = Object.values(data?.query?.pages ?? {})[0];
    if (!page?.extract) return null;
    const wikidata = /^Q\d+$/.test(page.pageprops?.wikibase_item ?? '') ? page.pageprops.wikibase_item : undefined;
    if (focus === 'legends') return { ...legendsSource(page.extract), url: page.fullurl, wikidata };
    return { text: articleStart(page.extract), url: page.fullurl, wikidata };
  },

  async otherArticle(wikidata, lang, focus = 'facts') {
    if (!/^Q\d+$/.test(wikidata)) return null;
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidata,
      props: 'sitelinks',
      sitefilter: OTHER_WIKIS.map((l) => `${l}wiki`).join('|'),
      format: 'json',
    });
    const data = await getJson(`https://www.wikidata.org/w/api.php?${params}`);
    const links = data?.entities?.[wikidata]?.sitelinks ?? {};
    const titles = OTHER_WIKIS.filter((l) => l !== lang && links[`${l}wiki`]?.title).map((l) => ({
      lang: l,
      title: links[`${l}wiki`].title as string,
    }));
    // Берём самую длинную из первых двух: обычно это английская или русская статья.
    const found = await Promise.all(
      titles.slice(0, 2).map((t) =>
        realGeoServices.wikiExtract(t.title, t.lang, focus).then(
          (e) => (e ? { ...e, lang: t.lang } : null),
          () => null,
        ),
      ),
    );
    return found.reduce<OtherArticle | null>((best, e) => (e && (!best || e.text.length > best.text.length) ? e : best), null);
  },
};
