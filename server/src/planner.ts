/** Генерация маршрута: кандидаты → отбор (ИИ или эвристика) → порядок → подгонка под бюджет. */
import type { AI } from './ai.ts';
import type { Budget, LatLng } from './geo.ts';
import { estimateDurationMin, haversine, orderStops, pathLength, WALK_DETOUR_FACTOR } from './geo.ts';
import type { Candidate, GeoServices, WalkPath } from './services.ts';

export interface PlanRequest {
  start: LatLng & { label?: string };
  budget: Budget;
  roundTrip: boolean;
  interests?: string;
  lang: string;
}

export interface PlannedStop extends Candidate {
  teaser: string;
}

export interface Plan {
  title: string;
  description: string;
  stops: PlannedStop[];
  path: WalkPath;
  durationMin: number;
  planner: 'ai' | 'heuristic';
  notices: string[];
}

export class NoCandidatesError extends Error {}

const MAX_AI_CANDIDATES = 80;
const OVERSHOOT_TOLERANCE = 1.2;
const MAX_REROUTES = 5;
/** Две точки ближе этого — по сути одна остановка. */
const MIN_SPACING_M = 50;

const KIND_WEIGHT: Record<string, number> = {
  attraction: 3,
  museum: 3,
  viewpoint: 3,
  castle: 3,
  monument: 2.5,
  memorial: 1.5,
  place_of_worship: 2,
  theatre: 2,
  gallery: 2,
  park: 1.5,
  artwork: 1.5,
  fountain: 1,
  heritage: 1.5,
  wikipedia: 1,
  wikidata: 1,
};

function score(c: Candidate, radius: number): number {
  const kind = KIND_WEIGHT[c.kind] ?? 1;
  const hasArticle = c.wikiTitle ? 2 : 0;
  const closeness = 1 - Math.min(c.distanceFromStart / Math.max(radius, 1), 1);
  // Статья на 100 000 знаков даёт +2, на 1000 знаков — 0.
  const byArticle = c.articleLength ? Math.max(0, Math.log10(c.articleLength) - 3) : 0;
  // Статьи в 100 разделах Википедии дают +2, в 10 — +1: для мест без статьи на языке маршрута.
  const bySitelinks = c.sitelinks ? Math.log10(c.sitelinks) : 0;
  const fame = Math.max(byArticle, bySitelinks);
  const image = c.hasImage ? 0.5 : 0;
  const notPlace = c.isPlace === false ? -5 : 0;
  // Объект в реестре наследия: государство сочло его ценным, даже если статьи о нём нет.
  const heritage = c.heritageRef ? 0.5 : 0;
  return kind + hasArticle + closeness + fame + image + notPlace + heritage;
}

export function rankCandidates(candidates: Candidate[], radius: number): Candidate[] {
  return [...candidates].sort((a, b) => score(b, radius) - score(a, radius));
}

/** Запасной отбор без ИИ: лучшие по очкам, пока прямая оценка длины укладывается в бюджет. */
export function selectHeuristic(req: PlanRequest, ranked: Candidate[]): Candidate[] {
  const chosen: Candidate[] = [];
  const places = ranked.filter((c) => c.isPlace !== false);
  const pool = places.length > 0 ? places : ranked;
  const { walkMeters, maxMinutes } = req.budget;
  for (const c of pool) {
    if (chosen.length >= req.budget.maxStops) break;
    if (chosen.some((s) => haversine(s, c) < MIN_SPACING_M)) continue;
    const trial = orderStops(req.start, [...chosen, c], req.roundTrip);
    const walk = pathLength(req.start, trial, req.roundTrip) * WALK_DETOUR_FACTOR;
    const inTime = maxMinutes === undefined || estimateDurationMin(walk, trial.length) <= maxMinutes;
    if (walk <= walkMeters && inTime) chosen.push(c);
  }
  // Даже при очень коротком бюджете маршрут должен куда-то вести.
  if (chosen.length === 0 && pool[0]) chosen.push(pool[0]);
  return chosen;
}

/** Точка, удаление которой сильнее всего сокращает путь. */
function worstStop<T extends LatLng>(start: LatLng, stops: T[], roundTrip: boolean): number {
  let worst = 0;
  let bestLen = Infinity;
  stops.forEach((_, i) => {
    const len = pathLength(start, stops.filter((__, j) => j !== i), roundTrip);
    if (len < bestLen) {
      bestLen = len;
      worst = i;
    }
  });
  return worst;
}

/** Реальный путь по улицам длиннее прямой, поэтому лишние точки снимаем уже по данным OSRM. */
async function fitToBudget<T extends LatLng>(
  req: PlanRequest,
  stops: T[],
  geo: GeoServices,
): Promise<{ stops: T[]; path: WalkPath }> {
  let current = orderStops(req.start, stops, req.roundTrip);
  let path = await geo.walkPath(req.start, current, req.roundTrip);
  for (let i = 0; i < MAX_REROUTES; i++) {
    const { walkMeters, maxMinutes } = req.budget;
    const tooFar = path.distanceM > walkMeters * OVERSHOOT_TOLERANCE;
    const tooLong =
      maxMinutes !== undefined && estimateDurationMin(path.distanceM, current.length) > maxMinutes * OVERSHOOT_TOLERANCE;
    if ((!tooFar && !tooLong) || current.length <= 1) break;
    const drop = worstStop(req.start, current, req.roundTrip);
    current = current.filter((_, j) => j !== drop);
    path = await geo.walkPath(req.start, current, req.roundTrip);
  }
  return { stops: current, path };
}

const AI_FALLBACK_NOTICE = 'ИИ сейчас недоступен, точки подобраны автоматически по данным карты.';

export async function planRoute(
  req: PlanRequest,
  geo: GeoServices,
  ai: AI | null,
  log: (err: unknown) => void = () => {},
): Promise<Plan> {
  const all = await geo.findCandidates(req.start, req.budget.searchRadius, req.lang);
  if (all.length === 0) throw new NoCandidatesError();
  const ranked = rankCandidates(all, req.budget.searchRadius).slice(0, MAX_AI_CANDIDATES);

  const notices: string[] = [];
  let planner: Plan['planner'] = 'heuristic';
  let title = req.start.label ? `Прогулка: ${req.start.label.split(',')[0]}` : 'Прогулка по окрестностям';
  let description = 'Подборка интересных мест рядом со стартовой точкой.';
  let selected: PlannedStop[] = [];

  if (ai) {
    try {
      const res = await ai.selectStops({
        start: req.start,
        candidates: ranked,
        walkMeters: req.budget.walkMeters,
        maxStops: req.budget.maxStops,
        maxMinutes: req.budget.maxMinutes,
        roundTrip: req.roundTrip,
        interests: req.interests,
        lang: req.lang,
      });
      const byId = new Map(ranked.map((c) => [c.id, c]));
      const seen = new Set<string>();
      for (const s of res.stops) {
        const c = byId.get(s.candidateId);
        if (!c || seen.has(c.id) || selected.length >= req.budget.maxStops) continue;
        seen.add(c.id);
        selected.push({ ...c, teaser: s.teaser });
      }
      if (selected.length > 0) {
        planner = 'ai';
        title = res.title.slice(0, 120) || title;
        description = res.description.slice(0, 1000) || description;
      } else {
        log(new Error('ИИ не вернул ни одного кандидата из списка'));
        notices.push(AI_FALLBACK_NOTICE);
      }
    } catch (err) {
      log(err);
      notices.push(AI_FALLBACK_NOTICE);
    }
  }
  if (selected.length === 0) {
    selected = selectHeuristic(req, ranked).map((c) => ({ ...c, teaser: '' }));
  }

  const fitted = await fitToBudget(req, selected, geo);
  if (!fitted.path.routed) {
    notices.push('Сервис пеших маршрутов недоступен: линии на карте прямые, длина оценочная.');
  }
  return {
    title,
    description,
    stops: fitted.stops,
    path: fitted.path,
    durationMin: estimateDurationMin(fitted.path.distanceM, fitted.stops.length),
    planner,
    notices,
  };
}
