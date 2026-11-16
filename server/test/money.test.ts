import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDb, tx } from '../src/db.ts';
import { post, reconcile, userAccount } from '../src/ledger.ts';
import { checkExpected } from '../src/money.ts';
import type { GeoServices } from '../src/services.ts';
import { paymentsFromEnv, pricingFromEnv, servicesFromEnv } from '../src/settings.ts';

const geo = {} as GeoServices;

describe('монетизация: основа', () => {
  let dir: string;
  let app: FastifyInstance;
  let db: DatabaseSync;
  let n = 0;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-money-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => app?.close());

  const start = async (env: Record<string, string> = {}) => {
    const sub = mkdtempSync(path.join(dir, 't-'));
    db = openDb(path.join(sub, 'db.sqlite'));
    app = await buildApp({
      db,
      geo,
      ai: null,
      tts: null,
      uploadsDir: path.join(sub, 'uploads'),
      pricing: pricingFromEnv(env),
      payments: paymentsFromEnv(env),
    });
  };

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };

  const register = async () => {
    const res = await call('POST', '/api/auth/register', undefined, {
      email: `m${++n}@example.com`,
      password: 'correct horse',
      name: `Покупатель ${n}`,
    });
    return { token: res.json.token as string, user: res.json.user };
  };

  /** Начисление, как при успешном платеже (сам платёж — в задачах US1). */
  const credit = (userId: string, points: number) => {
    const id = randomUUID();
    const ts = new Date().toISOString();
    tx(db, () => {
      const txId = post(db, {
        kind: 'topup',
        refType: 'payment',
        refId: id,
        entries: [
          { account: 'sys:yookassa', amount: -points },
          { account: userAccount(userId), amount: points },
        ],
      });
      db.prepare(
        `INSERT INTO payments (id, user_id, points, amount_kop, status, ledger_tx_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
      ).run(id, userId, points, points * 100, txId, ts, ts);
    });
  };

  test('цены доступны всем; без шлюза платные функции выключены', async () => {
    await start({ PRICE_STORY: '12' });
    const res = await call('GET', '/api/pricing');
    assert.equal(res.status, 200);
    assert.equal(res.json.story, 12);
    assert.equal(res.json.route3h, 50);
    assert.deepEqual(res.json.topup, { min: 100, max: 15000 });
    assert.equal(res.json.paymentsEnabled, false);
    await app.close();
    await start({ PAYMENTS_PROVIDER: 'fake' });
    assert.equal((await call('GET', '/api/pricing')).json.paymentsEnabled, true);
  });

  test('счёт и история: только свои, с подписями операций', async () => {
    await start();
    assert.equal((await call('GET', '/api/wallet')).status, 401);
    assert.equal((await call('GET', '/api/wallet/history')).status, 401);
    const a = await register();
    const b = await register();
    assert.deepEqual((await call('GET', '/api/me', a.token)).json.user.wallet, { balance: 0, available: 0 });

    credit(a.user.id, 300);
    for (let i = 0; i < 3; i++) {
      tx(db, () =>
        post(db, {
          kind: 'charge',
          meta: { title: `Рассказ ${i}` },
          entries: [
            { account: userAccount(a.user.id), amount: -10 },
            { account: 'sys:revenue', amount: 10 },
          ],
        }),
      );
    }
    const wallet = (await call('GET', '/api/wallet', a.token)).json;
    assert.equal(wallet.balance, 270);
    assert.equal(wallet.available, 270);
    assert.equal(wallet.pendingPayout, null);
    assert.equal((await call('GET', '/api/me', a.token)).json.user.wallet.balance, 270);

    const page1 = (await call('GET', '/api/wallet/history?limit=2', a.token)).json;
    assert.deepEqual(
      page1.items.map((i: any) => [i.title, i.amount]),
      [
        ['Рассказ 2', -10],
        ['Рассказ 1', -10],
      ],
    );
    const page2 = (await call('GET', `/api/wallet/history?limit=2&before=${page1.next}`, a.token)).json;
    assert.deepEqual(
      page2.items.map((i: any) => [i.title, i.amount]),
      [
        ['Рассказ 0', -10],
        ['Покупка баллов', 300],
      ],
    );
    assert.equal(page2.next, null);
    assert.deepEqual((await call('GET', '/api/wallet/history', b.token)).json.items, []);
    assert.deepEqual(reconcile(db), []);
  });

  test('подтверждение цены: выше показанной — PRICE_CHANGED, ниже — допустимо', () => {
    assert.throws(() => checkExpected(50, undefined), (e: any) => e.code === 'PRICE_CHANGED' && e.status === 409 && e.extra.cost === 50);
    assert.throws(() => checkExpected(60, 50), (e: any) => e.code === 'PRICE_CHANGED');
    assert.doesNotThrow(() => checkExpected(40, 50));
  });

  test('настройки платежей: fake запрещён в production, ЮKassa требует ключи', () => {
    assert.throws(() => paymentsFromEnv({ PAYMENTS_PROVIDER: 'fake', NODE_ENV: 'production' }), /production/);
    assert.throws(() => paymentsFromEnv({ PAYMENTS_PROVIDER: 'yookassa' }), /YOOKASSA_SHOP_ID/);
    assert.throws(() => paymentsFromEnv({ PAYMENTS_PROVIDER: 'paypal' }), /PAYMENTS_PROVIDER/);
    const cfg = paymentsFromEnv({ PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_SHOP_ID: '1', YOOKASSA_SECRET_KEY: 'k' });
    assert.equal(cfg.provider, 'yookassa');
    assert.equal(cfg.checkIp, true);
    assert.equal(cfg.receipt.vatCode, 1);
    assert.equal(paymentsFromEnv({}).provider, null);
    // Ошибка в ценах не даёт сохранить настройки (как и другие несовместимые правки).
    assert.throws(() => servicesFromEnv({ PRICE_STORY: 'десять' }), /PRICE_STORY/);
  });
});

// ---------- US1: покупка баллов и платная генерация ----------

import type { AI } from '../src/ai.ts';
import { haversine } from '../src/geo.ts';
import type { Mail } from '../src/mail.ts';
import type { Candidate } from '../src/services.ts';

const START = { lat: 59.94, lng: 30.338 };
const YK_IP = '185.71.76.10';

const cand = (n: number, dLat: number, dLng: number, extra: Partial<Candidate> = {}): Candidate => {
  const p = { lat: START.lat + dLat, lng: START.lng + dLng };
  return { id: `c${n}`, name: `Место ${n}`, kind: 'attraction', wikiTitle: `Статья ${n}`, distanceFromStart: Math.round(haversine(START, p)), ...p, ...extra };
};

/** mp3 MPEG-2.5 слой III, 8 кбит/с, 8 кГц: кадр 72 байта и 0,072 с — длинная озвучка остаётся маленькой. */
const mp3Seconds = (sec: number): Buffer => {
  const frame = Buffer.concat([Buffer.from([0xff, 0xe3, 0x18, 0x00]), Buffer.alloc(68)]);
  return Buffer.concat(Array.from({ length: Math.ceil(sec / 0.072) }, () => frame));
};

describe('монетизация: покупка баллов и платная генерация (US1)', () => {
  let dir: string;
  let app: FastifyInstance;
  let db: DatabaseSync;
  let mails: Mail[];
  let n = 0;
  let failStoryFor: Set<string>;
  let candidates: Candidate[];
  let narrationSec: number;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-money-us1-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => app?.close());

  const fakeAi = (): AI => ({
    selectStops: async () => ({
      title: 'Прогулка',
      description: 'Описание',
      stops: candidates.map((c) => ({ candidateId: c.id, teaser: c.name })),
    }),
    writeStory: async (input) => {
      if (failStoryFor.has(input.name)) throw new Error('ИИ недоступен');
      return `Рассказ о месте ${input.name}`;
    },
  });

  const geo: GeoServices = {
    findCandidates: async () => candidates,
    walkPath: async (start, stops, roundTrip) => {
      const pts = roundTrip ? [start, ...stops, start] : [start, ...stops];
      return { distanceM: 1500, geometry: pts.map((p) => [p.lat, p.lng]), routed: true };
    },
    geocode: async () => [],
    reverseCity: async () => 'Санкт-Петербург',
    searchCities: async () => [],
    // Статьи нет только у «Места 1»: без ИИ рассказ для него не из чего сделать.
    wikiExtract: async (title) => (title === 'Статья 1' ? null : { text: `${title} — известное место.`, url: `https://ru.wikipedia.org/wiki/${title}` }),
    findArticle: async () => null,
    otherArticle: async () => null,
    placePhotos: async (items) => items.map(() => ({ wikidata: null, photo: null })),
    placeFacts: async () => null,
  };

  const start = async (opts: { env?: Record<string, string>; limit?: number; mail?: boolean } = {}) => {
    const env = { PAYMENTS_PROVIDER: 'fake', ...opts.env };
    const sub = mkdtempSync(path.join(dir, 't-'));
    db = openDb(path.join(sub, 'db.sqlite'));
    app = await buildApp({
      db,
      geo,
      ai: fakeAi(),
      tts: { name: 'тест', synthesize: async () => mp3Seconds(narrationSec) },
      uploadsDir: path.join(sub, 'uploads'),
      mailer: opts.mail ? { name: 'тест', send: async (m) => void mails.push(m) } : null,
      appUrl: 'https://dlyaprogulok.ru',
      routeMonthlyLimit: opts.limit ?? 1,
      pricing: pricingFromEnv(env),
      payments: paymentsFromEnv(env),
    });
  };

  beforeEach(() => {
    mails = [];
    failStoryFor = new Set();
    candidates = [cand(1, 0.002, 0), cand(2, 0, 0.003)];
    narrationSec = 30;
  });

  const call = async (method: string, url: string, token?: string, body?: unknown, remoteAddress?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
      ...(remoteAddress ? { remoteAddress } : {}),
    });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };

  const register = async () => {
    const res = await call('POST', '/api/auth/register', undefined, { email: `u${++n}@example.com`, password: 'correct horse', name: `Пользователь ${n}` });
    return { token: res.json.token as string, id: res.json.user.id as string };
  };

  const balance = async (token: string) => (await call('GET', '/api/wallet', token)).json;
  const idle = () => (app as any).jobs.idle() as Promise<void>;
  const gateway = () => (app as any).paymentGateway();
  const providerId = (paymentId: string) => (db.prepare('SELECT provider_id FROM payments WHERE id = ?').get(paymentId) as any).provider_id as string;
  const activeHolds = () => (db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'active'").get() as any).n as number;
  const notify = (event: string, id: string, ip = YK_IP) => call('POST', '/api/payments/yookassa/notify', undefined, { type: 'notification', event, object: { id } }, ip);

  const buy = async (token: string, points: number) => {
    const created = await call('POST', '/api/payments', token, { points });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const fake = await call('POST', `/api/dev/fake-payments/${created.json.payment.id}`, token, { result: 'succeeded' });
    assert.equal(fake.status, 200, JSON.stringify(fake.json));
    return created.json.payment.id as string;
  };

  // ---------- T013: покупка баллов ----------

  test('покупка: начисление ровно одно при повторных уведомлениях; чужой платёж не виден', async () => {
    await start();
    const a = await register();
    const b = await register();
    const created = await call('POST', '/api/payments', a.token, { points: 300 });
    assert.equal(created.status, 201);
    assert.equal(created.json.payment.status, 'pending');
    assert.match(created.json.payment.confirmationUrl, /\/wallet\?payment=[\w-]+&fake=1$/);
    const id = created.json.payment.id;
    assert.equal((await balance(a.token)).balance, 0);

    gateway().succeed(providerId(id));
    assert.equal((await notify('payment.succeeded', providerId(id))).status, 200);
    assert.equal((await notify('payment.succeeded', providerId(id))).status, 200);
    assert.equal((await balance(a.token)).balance, 300);
    const got = await call('GET', `/api/payments/${id}`, a.token);
    assert.equal(got.json.payment.status, 'succeeded');
    assert.equal((await call('GET', `/api/payments/${id}`, b.token)).status, 404);
    const history = (await call('GET', '/api/wallet/history', a.token)).json.items;
    assert.deepEqual(history.map((i: any) => [i.title, i.amount]), [['Покупка баллов', 300]]);
    assert.deepEqual(reconcile(db), []);
  });

  test('покупка: отмена не меняет баллы; опрос статуса сам сверяется с ЮKassa', async () => {
    await start();
    const a = await register();
    const id = (await call('POST', '/api/payments', a.token, { points: 200 })).json.payment.id;
    gateway().cancel(providerId(id), 'expired_on_confirmation');
    const got = await call('GET', `/api/payments/${id}`, a.token);
    assert.equal(got.json.payment.status, 'canceled');
    assert.equal(got.json.payment.cancelReason, 'expired_on_confirmation');
    assert.equal((await balance(a.token)).balance, 0);
    // Опрос без уведомления тоже начисляет.
    const id2 = (await call('POST', '/api/payments', a.token, { points: 150 })).json.payment.id;
    gateway().succeed(providerId(id2));
    assert.equal((await call('GET', `/api/payments/${id2}`, a.token)).json.payment.status, 'succeeded');
    assert.equal((await balance(a.token)).balance, 150);
  });

  test('уведомления: тело не доверенное, чужой IP — 403, сумма не совпала — mismatch', async () => {
    await start();
    const a = await register();
    const id = (await call('POST', '/api/payments', a.token, { points: 300 })).json.payment.id;
    // В теле «успешно», но ЮKassa отвечает, что платёж ещё не оплачен.
    assert.equal((await notify('payment.succeeded', providerId(id))).status, 200);
    assert.equal((await balance(a.token)).balance, 0);
    gateway().succeed(providerId(id));
    assert.equal((await notify('payment.succeeded', providerId(id), '127.0.0.1')).status, 403);
    assert.equal((await balance(a.token)).balance, 0);
    // Неизвестный платёж — тоже 200, ЮKassa не повторяет.
    assert.equal((await notify('payment.succeeded', 'нет-такого')).status, 200);

    const id2 = (await call('POST', '/api/payments', a.token, { points: 500 })).json.payment.id;
    gateway().succeed(providerId(id2), { amountKop: 100 });
    await notify('payment.succeeded', providerId(id2));
    assert.equal((await call('GET', `/api/payments/${id2}`, a.token)).json.payment.status, 'mismatch');
    assert.equal((await balance(a.token)).balance, 0);
    await notify('payment.succeeded', providerId(id));
    assert.equal((await balance(a.token)).balance, 300);
    assert.deepEqual(reconcile(db), []);
  });

  test('покупка: границы суммы, подтверждённая почта, выключенные платежи', async () => {
    await start({ mail: true });
    const a = await register();
    const unverified = await call('POST', '/api/payments', a.token, { points: 300 });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.json.code, 'EMAIL_NOT_VERIFIED');
    const link = mails.at(-1)!.text.match(/verify\?token=([\w-]+)/)![1];
    assert.equal((await call('POST', '/api/auth/verify', undefined, { token: link })).status, 200);
    assert.equal((await call('POST', '/api/payments', a.token, { points: 99 })).status, 400);
    assert.equal((await call('POST', '/api/payments', a.token, { points: 15001 })).status, 400);
    assert.equal((await call('POST', '/api/payments', a.token, { points: 100.5 })).status, 400);
    assert.equal((await call('POST', '/api/payments', a.token, { points: 100 })).status, 201);
    assert.equal((await call('POST', '/api/payments', undefined, { points: 100 })).status, 401);
    await app.close();

    await start({ env: { PAYMENTS_PROVIDER: '' } });
    const b = await register();
    const off = await call('POST', '/api/payments', b.token, { points: 300 });
    assert.equal(off.status, 503);
    assert.equal(off.json.code, 'PAYMENTS_DISABLED');
    assert.equal((await call('POST', '/api/dev/fake-payments/x', b.token, { result: 'succeeded' })).status, 404);
  });

  // ---------- T014: платная генерация ----------

  test('бесплатный лимит: маршрут с рассказами и озвучкой без списаний', async () => {
    await start();
    const a = await register();
    const quote = (await call('GET', '/api/routes/quote?durationMin=60', a.token)).json;
    assert.deepEqual({ free: quote.free, freeLeft: quote.freeLeft, limit: quote.limit, cost: quote.cost }, { free: true, freeLeft: 1, limit: 1, cost: 0 });
    const res = await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60, background: true, autoStories: true });
    assert.equal(res.status, 202, JSON.stringify(res.json));
    await idle();
    const job = (await call('GET', `/api/jobs/${res.json.job.id}`, a.token)).json.job;
    assert.equal(job.status, 'done');
    assert.equal(job.billing, 'free');
    assert.equal(job.charged, 0);
    const route = (await call('GET', `/api/routes/${job.routeId}`, a.token)).json.route;
    assert.ok(route.points.every((p: any) => p.story), 'рассказы созданы');
    assert.ok(route.points.some((p: any) => p.narrationUrl), 'озвучка создана');
    assert.equal((db.prepare('SELECT free_generation FROM routes WHERE id = ?').get(job.routeId) as any).free_generation, 1);
    assert.equal((await balance(a.token)).balance, 0);
  });

  test('сверх лимита: подтверждение цены, нехватка баллов, списание ровно цены, возврат резерва при ошибке', async () => {
    await start();
    const a = await register();
    assert.equal((await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60 })).status, 201);

    const quote = (await call('GET', '/api/routes/quote?durationMin=200', a.token)).json;
    assert.deepEqual({ free: quote.free, cost: quote.cost }, { free: false, cost: 100 });
    const body = { start: START, durationMin: 200 };
    const noConfirm = await call('POST', '/api/routes/generate', a.token, body);
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.json.code, 'PRICE_CHANGED');
    assert.equal(noConfirm.json.cost, 100);
    assert.equal((await call('POST', '/api/routes/generate', a.token, { ...body, expectedCost: 50 })).json.code, 'PRICE_CHANGED');
    const poor = await call('POST', '/api/routes/generate', a.token, { ...body, expectedCost: 100 });
    assert.equal(poor.status, 402);
    assert.deepEqual([poor.json.code, poor.json.need, poor.json.available], ['INSUFFICIENT_POINTS', 100, 0]);

    await buy(a.token, 300);
    const paid = await call('POST', '/api/routes/generate', a.token, { ...body, expectedCost: 100, autoStories: true });
    assert.equal(paid.status, 201, JSON.stringify(paid.json));
    assert.ok(paid.json.notices.some((t: string) => t.includes('после создания')), 'рассказы заказываются отдельно');
    assert.ok(paid.json.route.points.every((p: any) => !p.story), 'автоматических рассказов нет');
    assert.equal((await balance(a.token)).balance, 200);

    // Ошибка подбора: резерв снят, баллы на месте.
    candidates = [];
    const failed = await call('POST', '/api/routes/generate', a.token, { ...body, expectedCost: 100 });
    assert.equal(failed.status, 422);
    assert.equal((await balance(a.token)).balance, 200);
    assert.equal(activeHolds(), 0);

    candidates = [cand(1, 0.002, 0), cand(2, 0, 0.003)];
    const bg = await call('POST', '/api/routes/generate', a.token, { ...body, background: true, expectedCost: 100 });
    assert.equal(bg.status, 202);
    assert.equal((await balance(a.token)).reserved, 100);
    await idle();
    const job = (await call('GET', `/api/jobs/${bg.json.job.id}`, a.token)).json.job;
    assert.deepEqual([job.status, job.billing, job.charged, job.reserved], ['done', 'paid', 100, 0]);
    assert.equal((await balance(a.token)).balance, 100);

    // Перезапуск: задача выполняется заново — второго списания нет.
    db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(bg.json.job.id);
    (app as any).jobs.kick();
    await idle();
    assert.equal((await balance(a.token)).balance, 100);
    assert.equal(activeHolds(), 0);
    assert.deepEqual(reconcile(db), []);
  });

  test('рассказы за баллы: списание только за созданное, озвучка не дороже оценки', async () => {
    await start({ env: { PAYMENTS_PROVIDER: 'fake', STORY_AVG_CHARS: '1200' } });
    const a = await register();
    await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60 });
    await buy(a.token, 300);
    const route = (await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60, expectedCost: 50 })).json.route;
    assert.equal((await balance(a.token)).balance, 250);

    const quote = (await call('GET', `/api/routes/${route.id}/stories/quote`, a.token)).json;
    // 2 точки × (рассказ 10 + оценка озвучки 1200 симв. ≈ 86 с → 10).
    assert.equal(quote.cost, 40);
    assert.equal(quote.items.length, 2);
    assert.equal((await call('POST', `/api/routes/${route.id}/stories`, a.token, {})).json.code, 'PRICE_CHANGED');

    failStoryFor = new Set(['Место 1']);
    narrationSec = 130; // по факту 3 отрезка по 2 минуты, но не дороже оценки (10)
    const started = await call('POST', `/api/routes/${route.id}/stories`, a.token, { expectedCost: 40 });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    await idle();
    const job = (await call('GET', `/api/jobs/${started.json.job.id}`, a.token)).json.job;
    assert.equal(job.failed, 1);
    assert.equal(job.charged, 20, 'рассказ 10 + озвучка 10 только для «Места 2»');
    assert.equal((await balance(a.token)).balance, 230);
    assert.equal(activeHolds(), 0);
    assert.deepEqual(reconcile(db), []);
  });

  test('рассказ для точки: повторная генерация на бесплатном маршруте платная, озвучка по факту', async () => {
    await start();
    const a = await register();
    const res = await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60, background: true, autoStories: true });
    await idle();
    const routeId = (await call('GET', `/api/jobs/${res.json.job.id}`, a.token)).json.job.routeId;
    const point = (await call('GET', `/api/routes/${routeId}`, a.token)).json.route.points[1];

    const quote = (await call('GET', `/api/points/${point.id}/story/quote`, a.token)).json;
    assert.deepEqual([quote.cost, quote.story, quote.narrationEstimate], [20, 10, 10]);
    const voiceOnly = (await call('GET', `/api/points/${point.id}/story/quote?keepText=true`, a.token)).json;
    assert.equal(voiceOnly.story, 0);
    assert.equal((await call('POST', `/api/points/${point.id}/story`, a.token, { fresh: true })).json.code, 'PRICE_CHANGED');
    const poor = await call('POST', `/api/points/${point.id}/story`, a.token, { fresh: true, expectedCost: 20 });
    assert.equal(poor.status, 402);

    await buy(a.token, 100);
    narrationSec = 30;
    const done = await call('POST', `/api/points/${point.id}/story`, a.token, { fresh: true, expectedCost: 20 });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.charged, 20);
    assert.equal((await balance(a.token)).balance, 80);
    assert.equal(activeHolds(), 0);

    // Ошибка создания — ничего не списано.
    failStoryFor = new Set([point.name]);
    const pointRow = db.prepare('SELECT * FROM points WHERE id = ?').get(point.id) as any;
    db.prepare('UPDATE points SET wiki_title = ?, facts = NULL WHERE id = ?').run('Статья 1', point.id);
    const fail = await call('POST', `/api/points/${point.id}/story`, a.token, { fresh: true, expectedCost: 20 });
    assert.ok(fail.status >= 400, JSON.stringify(fail.json));
    assert.equal((await balance(a.token)).balance, 80);
    assert.equal(activeHolds(), 0);
    assert.ok(pointRow);
    assert.deepEqual(reconcile(db), []);
  });

  test('без платёжного шлюза: сверх лимита — прежний отказ, рассказы бесплатны', async () => {
    await start({ env: { PAYMENTS_PROVIDER: '' } });
    const a = await register();
    const first = await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60 });
    assert.equal(first.status, 201);
    const over = await call('POST', '/api/routes/generate', a.token, { start: START, durationMin: 60, expectedCost: 50 });
    assert.equal(over.status, 429);
    const quote = (await call('GET', '/api/routes/quote?durationMin=60', a.token)).json;
    assert.equal(quote.paymentsEnabled, false);
    const stories = await call('POST', `/api/routes/${first.json.route.id}/stories`, a.token, {});
    assert.equal(stories.status, 202);
    await idle();
    assert.equal((await balance(a.token)).balance, 0);
  });
});

// ---------- Шлюз ЮKassa и служебные проверки ----------

import { hold } from '../src/ledger.ts';
import { sweepHolds } from '../src/money.ts';
import { createYookassa, isYookassaIp } from '../src/payments.ts';

describe('ЮKassa и зависшие резервы', () => {
  test('адреса уведомлений ЮKassa', () => {
    for (const ip of ['185.71.76.0', '185.71.76.31', '185.71.77.10', '77.75.153.127', '77.75.156.11', '77.75.156.35', '77.75.154.200', '::ffff:185.71.76.5', '2a02:5180:0:1::1']) {
      assert.ok(isYookassaIp(ip), ip);
    }
    for (const ip of ['185.71.76.32', '77.75.153.128', '77.75.156.12', '127.0.0.1', '10.0.0.1', '2a02:5181::1', 'мусор']) {
      assert.ok(!isYookassaIp(ip), ip);
    }
  });

  test('запрос к API: авторизация, ключ идемпотентности, чек; ошибка без секрета', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let reply: Response = new Response(
      JSON.stringify({
        id: 'yk-1',
        status: 'pending',
        paid: false,
        amount: { value: '300.00', currency: 'RUB' },
        metadata: { payment_id: 'p-1' },
        confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru/checkout/1' },
      }),
      { status: 200 },
    );
    const gw = createYookassa({
      shopId: '123',
      secretKey: 'live_SECRET',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return reply;
      }) as typeof fetch,
    });
    const receipt = { vatCode: 1, taxSystem: 2, paymentMode: 'full_prepayment', paymentSubject: 'service' };
    const created = await gw.createPayment({
      id: 'p-1',
      amountKop: 30000,
      description: 'Баллы сервиса «Для прогулок», 300 шт.',
      returnUrl: 'https://dlyaprogulok.ru/wallet?payment=p-1',
      email: 'a@example.com',
      receipt,
    });
    assert.equal(created.confirmationUrl, 'https://yoomoney.ru/checkout/1');
    assert.equal(created.amountKop, 30000);
    assert.equal(created.metadataId, 'p-1');
    const { url, init } = calls[0]!;
    assert.equal(url, 'https://api.yookassa.ru/v3/payments');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Basic ' + Buffer.from('123:live_SECRET').toString('base64'));
    assert.equal(headers['Idempotence-Key'], 'p-1');
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.amount, { value: '300.00', currency: 'RUB' });
    assert.equal(body.capture, true);
    assert.deepEqual(body.confirmation, { type: 'redirect', return_url: 'https://dlyaprogulok.ru/wallet?payment=p-1' });
    assert.deepEqual(body.metadata, { payment_id: 'p-1' });
    assert.equal(body.receipt.customer.email, 'a@example.com');
    assert.equal(body.receipt.tax_system_code, 2);
    assert.deepEqual(body.receipt.items[0], {
      description: 'Баллы сервиса «Для прогулок», 300 шт.',
      quantity: '1.00',
      amount: { value: '300.00', currency: 'RUB' },
      vat_code: 1,
      payment_mode: 'full_prepayment',
      payment_subject: 'service',
    });

    reply = new Response(JSON.stringify({ type: 'error', code: 'invalid_credentials', description: 'Bad key' }), { status: 401 });
    await assert.rejects(
      () => gw.getPayment('yk-1'),
      (err: Error) => err.message.includes('401') && err.message.includes('invalid_credentials') && !err.message.includes('SECRET'),
    );
  });

  test('резерв задачи, которой уже нет, и прерванного запроса снимается', () => {
    const db = openDb(':memory:');
    const ts = new Date().toISOString();
    tx(db, () =>
      post(db, {
        kind: 'topup',
        entries: [
          { account: 'sys:yookassa', amount: -100 },
          { account: userAccount('u'), amount: 100 },
        ],
      }),
    );
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'u@x.ru', 'U', 'x', ?)").run(ts);
    db.prepare(
      "INSERT INTO jobs (id, user_id, kind, status, params, created_at, updated_at) VALUES ('alive', 'u', 'stories', 'running', '{}', ?, ?)",
    ).run(ts, ts);
    const alive = tx(db, () => hold(db, { userId: 'u', kind: 'charge', amount: 10, refType: 'job', refId: 'alive' }));
    const gone = tx(db, () => hold(db, { userId: 'u', kind: 'charge', amount: 20, refType: 'job', refId: 'deleted-with-route' }));
    const fresh = tx(db, () => hold(db, { userId: 'u', kind: 'charge', amount: 30, refType: 'request', refId: 'r1' }));
    const old = tx(db, () => hold(db, { userId: 'u', kind: 'charge', amount: 5, refType: 'request', refId: 'r2' }));
    const payout = tx(db, () => hold(db, { userId: 'u', kind: 'payout', amount: 15 }));
    db.prepare('UPDATE holds SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), old.id);
    assert.equal(sweepHolds(db), 2);
    const status = (id: string) => (db.prepare('SELECT status FROM holds WHERE id = ?').get(id) as any).status;
    assert.deepEqual(
      [alive, gone, fresh, old, payout].map((h) => status(h.id)),
      ['active', 'released', 'active', 'released', 'active'],
    );
  });
});
