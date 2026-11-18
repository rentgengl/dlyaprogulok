/**
 * Цены платных действий в баллах (1 балл = 1 ₽). Значения задаются в настройках (группа «Монетизация»);
 * здесь только расчёт. Все суммы — целые баллы.
 */
import { computeBudget, estimateDurationMin, type RouteTarget } from './geo.ts';

export interface Pricing {
  /** Подбор маршрута: за каждые начатые 3 часа прогулки. */
  route3h: number;
  /** Рассказ для одной точки. */
  story: number;
  /** Озвучка: за каждые начатые 2 минуты звучания. */
  narration2min: number;
  /** Оценка длительности озвучки до её создания. */
  narrationCharsPerSec: number;
  /** Средняя длина рассказа: для оценки озвучки, пока текста ещё нет. */
  storyAvgChars: number;
  saleCommissionPct: number;
  payoutCommissionPct: number;
  routePriceMin: number;
  routePriceMax: number;
  tipMin: number;
  tipMax: number;
  topupMin: number;
  topupMax: number;
  payoutMin: number;
}

/**
 * Расчётное время прогулки до подбора: для маршрута по времени — заданное, для маршрута по длине —
 * та же оценка, что приложение показывает у готового маршрута (ходьба + остановки).
 */
export function routeMinutes(target: RouteTarget, roundTrip = false): number {
  if ('durationMin' in target) return target.durationMin;
  const { maxStops } = computeBudget(target, roundTrip);
  return estimateDurationMin(target.distanceM, maxStops);
}

export const routeCost = (minutes: number, p: Pricing): number => Math.max(1, Math.ceil(minutes / 180)) * p.route3h;

export const storyCost = (p: Pricing): number => p.story;

export const narrationCost = (seconds: number, p: Pricing): number =>
  seconds > 0 ? Math.ceil(seconds / 120) * p.narration2min : 0;

export const narrationEstimateSec = (chars: number, p: Pricing): number =>
  chars > 0 ? Math.ceil(chars / p.narrationCharsPerSec) : 0;

export interface StoryQuoteItem {
  /** Цена текста: 0, если текст не пишется (только озвучка). */
  story: number;
  /** Оценка цены озвучки; списывается не больше неё. */
  narrationEstimate: number;
}

/**
 * Оценка для одной точки. writeStory — будет написан новый текст (его длина неизвестна, берётся средняя);
 * иначе озвучивается существующий текст длиной textChars.
 */
export function storyItemQuote(
  p: Pricing,
  opts: { writeStory: boolean; textChars?: number; withNarration: boolean },
): StoryQuoteItem {
  const chars = opts.writeStory ? p.storyAvgChars : (opts.textChars ?? 0);
  return {
    story: opts.writeStory ? storyCost(p) : 0,
    narrationEstimate: opts.withNarration ? narrationCost(narrationEstimateSec(chars, p), p) : 0,
  };
}

export const quoteTotal = (items: StoryQuoteItem[]): number =>
  items.reduce((sum, i) => sum + i.story + i.narrationEstimate, 0);

/** Доля автора с продажи или премии округляется вниз; остаток — комиссия сервиса. */
export function splitShare(amount: number, pct: number): { author: number; commission: number } {
  const author = Math.floor((amount * (100 - pct)) / 100);
  return { author, commission: amount - author };
}

/** Вывод: списывается points баллов, к выплате — рубли за вычетом комиссии (в копейках, вниз). */
export function payoutQuote(points: number, pct: number): { points: number; feePct: number; payoutKop: number; feeKop: number } {
  const payoutKop = Math.floor((points * 100 * (100 - pct)) / 100);
  return { points, feePct: pct, payoutKop, feeKop: points * 100 - payoutKop };
}
