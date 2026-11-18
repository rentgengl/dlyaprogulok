import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBudget, estimateDurationMin } from '../src/geo.ts';
import {
  narrationCost,
  narrationEstimateSec,
  payoutQuote,
  quoteTotal,
  routeCost,
  routeMinutes,
  storyItemQuote,
  type Pricing,
} from '../src/pricing.ts';
import { pricingFromEnv } from '../src/settings.ts';
import { mp3DurationSec } from '../src/tts.ts';

const p: Pricing = pricingFromEnv({});

test('цены по умолчанию из спецификации', () => {
  assert.equal(p.route3h, 50);
  assert.equal(p.story, 10);
  assert.equal(p.narration2min, 10);
  assert.equal(p.saleCommissionPct, 20);
  assert.equal(p.payoutCommissionPct, 5);
  assert.equal(p.payoutMin, 500);
});

test('маршрут: 50 баллов за каждые начатые 3 часа', () => {
  assert.equal(routeCost(60, p), 50);
  assert.equal(routeCost(180, p), 50);
  assert.equal(routeCost(181, p), 100);
  assert.equal(routeCost(360, p), 100);
  assert.equal(routeCost(480, p), 150);
});

test('маршрут по длине считается той же оценкой времени, что и готовый маршрут', () => {
  const target = { distanceM: 9000 };
  const expected = estimateDurationMin(9000, computeBudget(target, false).maxStops);
  assert.equal(routeMinutes(target), expected);
  assert.equal(routeMinutes({ durationMin: 200 }), 200);
});

test('озвучка: 10 баллов за каждые начатые 2 минуты', () => {
  assert.equal(narrationCost(0, p), 0);
  assert.equal(narrationCost(60, p), 10);
  assert.equal(narrationCost(120, p), 10);
  assert.equal(narrationCost(121, p), 20);
  assert.equal(narrationEstimateSec(1400, p), 100);
});

test('оценка рассказов: текст + озвучка средней длины; только озвучка — по своему тексту', () => {
  const write = storyItemQuote(p, { writeStory: true, withNarration: true });
  assert.deepEqual(write, { story: 10, narrationEstimate: 10 }); // 1200 символов ≈ 86 с
  const voice = storyItemQuote(p, { writeStory: false, textChars: 2000, withNarration: true });
  assert.deepEqual(voice, { story: 0, narrationEstimate: 20 }); // ≈ 143 с
  assert.equal(quoteTotal([write, voice]), 40);
  assert.equal(storyItemQuote(p, { writeStory: true, withNarration: false }).narrationEstimate, 0);
});

test('вывод: комиссия 5 %, сумма к выплате в копейках вниз', () => {
  assert.deepEqual(payoutQuote(1000, 5), { points: 1000, feePct: 5, payoutKop: 95000, feeKop: 5000 });
  assert.deepEqual(payoutQuote(333, 5), { points: 333, feePct: 5, payoutKop: 31635, feeKop: 1665 });
});

test('настройки цен: ошибки диапазона понятны', () => {
  assert.throws(() => pricingFromEnv({ PRICE_STORY: '-1' }), /PRICE_STORY/);
  assert.throws(() => pricingFromEnv({ SALE_COMMISSION_PCT: '120' }), /SALE_COMMISSION_PCT/);
  assert.throws(() => pricingFromEnv({ TIP_MIN: '100', TIP_MAX: '10' }), /TIP_MIN/);
  assert.equal(pricingFromEnv({ PRICE_ROUTE_3H: '70' }).route3h, 70);
});

/** MPEG-1 слой III, 128 кбит/с, 44,1 кГц: кадр 417 байт, 1152 отсчёта. */
function mp3Frames(count: number, padding = false): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90 | (padding ? 0x02 : 0), 0x00]);
  const frameLen = 417 + (padding ? 1 : 0);
  const frame = Buffer.concat([header, Buffer.alloc(frameLen - 4)]);
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

test('длительность mp3 по кадрам', () => {
  const sec = mp3DurationSec(mp3Frames(100));
  assert.ok(Math.abs(sec - (100 * 1152) / 44100) < 1e-9, String(sec));
  // ID3v2 в начале и мусор не мешают.
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]);
  const withTag = Buffer.concat([id3, Buffer.from([1, 2, 3]), mp3Frames(50, true)]);
  assert.ok(Math.abs(mp3DurationSec(withTag) - (50 * 1152) / 44100) < 1e-9);
  assert.equal(mp3DurationSec(Buffer.from('mp3:не аудио')), 0);
});
