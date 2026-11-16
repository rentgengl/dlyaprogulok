import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AI, StoryInput } from '../src/ai.ts';
import { buildApp, monthWindow } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { haversine, pathLength } from '../src/geo.ts';
import { createMailerFromEnv, verificationMail, type Mail } from '../src/mail.ts';
import {
  commonsFileName,
  commonsPhotos,
  factsStory,
  findPhotos,
  formatWikidataTime,
  heritageNearby,
  mergeFacts,
  osmFacts,
  plainText,
  wikidataFacts,
  type PlacePhoto,
} from '../src/places.ts';
import { ARTICLE_CHARS, articleStart, heritageCandidates, mergeCandidates, type Candidate, type GeoServices } from '../src/services.ts';
import { injectShareMeta, routeFacts } from '../src/share.ts';

const START = { lat: 59.94, lng: 30.338 };

const cand = (n: number, dLat: number, dLng: number, extra: Partial<Candidate> = {}): Candidate => {
  const p = { lat: START.lat + dLat, lng: START.lng + dLng };
  return {
    id: `c${n}`,
    name: `Место ${n}`,
    kind: 'attraction',
    wikiTitle: `Статья ${n}`,
    distanceFromStart: Math.round(haversine(START, p)),
    ...p,
    ...extra,
  };
};

const PHOTO: PlacePhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Dom.jpg/800px-Dom.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Dom.jpg',
  author: 'Иван Петров',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
};

const CANDIDATES = [
  cand(1, 0.002, 0, { wikidata: 'Q1' }),
  // Без статьи: дом из реестра наследия, справка — из Викиданных и OSM.
  cand(2, 0, 0.003, {
    id: 'osm:way/42',
    name: 'Дом Кочубея',
    wikiTitle: undefined,
    wikidata: 'Q42',
    heritageRef: '781720744490005',
    facts: [{ label: 'Создан', value: '1910' }],
  }),
];

const fakeGeo = (over: Partial<GeoServices> = {}): GeoServices => ({
  findCandidates: async () => CANDIDATES,
  walkPath: async (start, stops, roundTrip) => {
    const pts = roundTrip ? [start, ...stops, start] : [start, ...stops];
    return { distanceM: Math.round(pathLength(start, stops, roundTrip) * 1.3), geometry: pts.map((p) => [p.lat, p.lng]), routed: true };
  },
  geocode: async () => [],
  reverseCity: async () => 'Санкт-Петербург',
  searchCities: async () => [],
  wikiExtract: async (title) => ({ text: `${title} — известное место.`, url: `https://ru.wikipedia.org/wiki/${title}` }),
  findArticle: async () => null,
  otherArticle: async () => null,
  placePhotos: async (items) => items.map((i) => ({ wikidata: i.wikidata ?? null, photo: i.wikiTitle === 'Статья 1' ? PHOTO : null })),
  placeFacts: async (id) =>
    id === 'Q42'
      ? {
          label: 'Особняк Кочубея',
          description: 'особняк в Санкт-Петербурге',
          url: 'https://www.wikidata.org/wiki/Q42',
          facts: [
            { label: 'Архитектор', value: 'Мельцер' },
            { label: 'Охранный статус', value: 'объект культурного наследия регионального значения' },
            { label: 'Номер в реестре ЕГРОКН', value: '781720744490005' },
          ],
        }
      : null,
  ...over,
});

test('начало статьи: целиком, если короткая, иначе по границе абзаца', () => {
  assert.equal(articleStart('Коротко.\n'), 'Коротко.');
  const para = 'Абзац о соборе. '.repeat(40);
  const long = Array.from({ length: 40 }, () => para).join('\n');
  const start = articleStart(long);
  assert.ok(start.length <= ARTICLE_CHARS && start.length > ARTICLE_CHARS / 2);
  assert.ok(start.endsWith('Абзац о соборе.'));
});

describe('новые функции API', () => {
  let app: FastifyInstance;
  let dir: string;
  let sub: string;
  let mails: Mail[];
  let stories: StoryInput[];
  let ttsCalls: number;
  let n = 0;
  let geo: GeoServices;
  let ai: AI | null;

  const fakeAi = (): AI => ({
    selectStops: async () => ({
      title: 'Петербург <наследия>',
      description: 'Описание',
      stops: [
        { candidateId: 'c1', teaser: 'Первая' },
        { candidateId: 'osm:way/42', teaser: 'Вторая' },
      ],
    }),
    writeStory: async (input) => {
      stories.push(input);
      return `Рассказ о месте ${input.name} №${stories.length}`;
    },
  });

  const start = async (opts: { mail?: boolean; limit?: number; web?: string } = {}) => {
    sub = mkdtempSync(path.join(dir, 't-'));
    app = await buildApp({
      db: openDb(path.join(sub, 'db.sqlite')),
      geo,
      ai,
      tts: {
        name: 'тестовый голос',
        synthesize: async (text) => {
          ttsCalls++;
          return Buffer.from(`mp3:${text}`);
        },
      },
      uploadsDir: path.join(sub, 'uploads'),
      mailer: opts.mail ? { name: 'тест', send: async (m) => void mails.push(m) } : null,
      appUrl: 'https://dlyaprogulok.ru',
      routeMonthlyLimit: opts.limit,
      webIndexPath: opts.web,
    });
  };

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, body: res.body };
  };

  const register = async () => {
    const res = await call('POST', '/api/auth/register', undefined, {
      email: `f${++n}@example.com`,
      password: 'correct horse',
      name: `Пользователь ${n}`,
    });
    assert.equal(res.status, 201);
    return res.json as { token: string; user: any; mailSent: boolean };
  };

  const generate = (token: string) => call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 });

  const tokenFrom = (mail: Mail) => mail.text.match(/verify\?token=([\w-]+)/)![1]!;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-f-'));
  });
  beforeEach(() => {
    mails = [];
    stories = [];
    ttsCalls = 0;
    geo = fakeGeo();
    ai = fakeAi();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('подтверждение почты: письмо, запреты до подтверждения, ссылка, повторное письмо', async () => {
    await start({ mail: true });
    const { token, user, mailSent } = await register();
    assert.equal(user.emailVerified, false);
    assert.equal(mailSent, true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, user.email);
    assert.match(mails[0]!.text, /^https:\/\/dlyaprogulok\.ru\/verify\?token=/m);
    assert.equal((await call('GET', '/api/config')).json.emailVerification, true);

    const blocked = await generate(token);
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /Подтвердите почту/);

    // Повторное письмо: новая ссылка, старая тоже действует до истечения срока.
    assert.equal((await call('POST', '/api/auth/resend', token)).json.sent, true);
    assert.equal(mails.length, 2);

    assert.equal((await call('POST', '/api/auth/verify', undefined, { token: 'x'.repeat(40) })).status, 400);
    // Ссылку открыли без входа, например на другом устройстве.
    const anon = await call('POST', '/api/auth/verify', undefined, { token: tokenFrom(mails[1]!) });
    assert.equal(anon.status, 200);
    assert.equal(anon.json.verified, true);
    assert.equal(anon.json.user, null);
    // Ссылки одноразовые: после подтверждения все удаляются.
    assert.equal((await call('POST', '/api/auth/verify', undefined, { token: tokenFrom(mails[0]!) })).status, 400);

    assert.equal((await call('GET', '/api/me', token)).json.user.emailVerified, true);
    assert.equal((await generate(token)).status, 201);
    assert.equal((await call('POST', '/api/auth/resend', token)).json.sent, false);
  });

  test('подтверждение почты: публикация и оценки тоже ждут подтверждения', async () => {
    await start({ mail: true });
    const author = await register();
    await call('POST', '/api/auth/verify', author.token, { token: tokenFrom(mails[0]!) });
    const route = (await generate(author.token)).json.route;
    assert.equal((await call('PATCH', `/api/routes/${route.id}`, author.token, { isPublic: true })).status, 200);

    const guest = await register();
    const rate = await call('PUT', `/api/routes/${route.id}/rating`, guest.token, { value: 5 });
    assert.equal(rate.status, 403);
    const verified = await call('POST', '/api/auth/verify', guest.token, { token: tokenFrom(mails[1]!) });
    assert.equal(verified.json.user.emailVerified, true, 'вошедший получает обновлённый профиль');
    assert.equal((await call('PUT', `/api/routes/${route.id}/rating`, guest.token, { value: 5 })).status, 200);
  });

  test('без почтового сервиса подтверждение не требуется', async () => {
    await start();
    const { token, user, mailSent } = await register();
    assert.equal(user.emailVerified, true);
    assert.equal(mailSent, false);
    assert.equal((await generate(token)).status, 201);
    assert.equal((await call('POST', '/api/auth/resend', token)).status, 409);
  });

  test('сбой отправки письма не мешает регистрации', async () => {
    sub = mkdtempSync(path.join(dir, 't-'));
    app = await buildApp({
      db: openDb(path.join(sub, 'db.sqlite')),
      geo,
      ai,
      tts: null,
      uploadsDir: path.join(sub, 'uploads'),
      mailer: { name: 'сломанный', send: async () => { throw new Error('SMTP down'); } },
    });
    const { token, mailSent } = await register();
    assert.equal(mailSent, false);
    const resend = await call('POST', '/api/auth/resend', token);
    assert.equal(resend.status, 502);
    assert.match(resend.json.error, /Не удалось отправить письмо/);
  });

  test('лимит маршрутов в месяц: удаление не возвращает попытку', async () => {
    await start({ limit: 2 });
    const { token, user } = await register();
    assert.deepEqual([user.quota.limit, user.quota.used, user.quota.remaining], [2, 0, 2]);

    const first = await generate(token);
    assert.equal(first.json.quota.remaining, 1);
    assert.equal((await call('DELETE', `/api/routes/${first.json.route.id}`, token)).status, 204);
    assert.equal((await generate(token)).status, 201);

    const third = await generate(token);
    assert.equal(third.status, 429);
    assert.match(third.json.error, /создано 2 из 2 маршрутов.*с 1 /);
    const me = (await call('GET', '/api/me', token)).json.user;
    assert.equal(me.quota.remaining, 0);
    assert.ok(Date.parse(me.quota.resetsAt) > Date.now());

    // У другого пользователя свой счётчик.
    assert.equal((await generate((await register()).token)).status, 201);
  });

  test('лимит 0 — без ограничения', async () => {
    await start({ limit: 0 });
    const { token, user } = await register();
    assert.equal(user.quota.limit, null);
    for (let i = 0; i < 6; i++) assert.equal((await generate(token)).status, 201);
  });

  test('месяц лимита считается по московскому времени', () => {
    // 1 декабря, 01:00 по Москве — уже декабрь.
    const dec = monthWindow(Date.parse('2026-11-30T22:00:00Z'));
    assert.equal(dec.start.toISOString(), '2026-11-30T21:00:00.000Z');
    assert.equal(dec.end.toISOString(), '2026-12-31T21:00:00.000Z');
    // 30 ноября, 23:59 по Москве — ещё ноябрь.
    const nov = monthWindow(Date.parse('2026-11-30T20:59:00Z'));
    assert.equal(nov.start.toISOString(), '2026-10-31T21:00:00.000Z');
  });

  test('фото с Commons и сведения о месте сохраняются в точке', async () => {
    await start();
    const route = (await generate((await register()).token)).json.route;
    const first = route.points.find((p: any) => p.name === 'Место 1');
    const second = route.points.find((p: any) => p.name === 'Дом Кочубея');
    assert.deepEqual(first.photo, PHOTO);
    assert.equal(first.wikidata, 'Q1');
    assert.equal(second.photo, null);
    assert.equal(second.heritageRef, '781720744490005');
  });

  test('сбой Commons не мешает созданию маршрута', async () => {
    geo = fakeGeo({ placePhotos: async () => { throw new Error('Commons down'); } });
    await start();
    const res = await generate((await register()).token);
    assert.equal(res.status, 201);
    assert.equal(res.json.route.points[0].photo, null);
  });

  test('место без статьи: рассказ по справке Викиданных, реестра и OSM', async () => {
    await start();
    const { token } = await register();
    const route = (await generate(token)).json.route;
    const house = route.points.find((p: any) => p.name === 'Дом Кочубея');
    const res = await call('POST', `/api/points/${house.id}/story`, token, {});
    assert.equal(res.status, 200);
    const source = stories[0]!.source!;
    assert.match(source, /Описание: особняк в Санкт-Петербурге/);
    assert.match(source, /Архитектор: Мельцер/);
    assert.match(source, /Номер в реестре ЕГРОКН: 781720744490005/);
    assert.match(source, /Создан: 1910/, 'факт из тегов OSM');
    const point = res.json.route.points.find((p: any) => p.id === house.id);
    assert.equal(point.storySource, 'ai_facts');
    assert.equal(point.storySourceUrl, 'https://www.wikidata.org/wiki/Q42');
  });

  test('короткая статья: в источник идут статья на другом языке и справка Викиданных', async () => {
    const asked: string[] = [];
    geo = fakeGeo({
      wikiExtract: async (title) => ({ text: `${title} — известное место.`, url: 'https://ru.wikipedia.org/wiki/x', wikidata: 'Q42' }),
      otherArticle: async (id, lang) => {
        asked.push(`${id}:${lang}`);
        return { text: 'A mansion built in 1910 by Meltzer.', url: 'https://en.wikipedia.org/wiki/Kochubey_House', lang: 'en' };
      },
    });
    await start();
    const { token } = await register();
    const route = (await generate(token)).json.route;
    // Первая точка привязана к Q1: id Викиданных точки важнее id из статьи.
    const place1 = route.points.find((p: any) => p.name === 'Место 1');
    const first = (await call('POST', `/api/points/${place1.id}/story`, token, {})).json.route.points.find((p: any) => p.id === place1.id);
    assert.equal(asked[0], 'Q1:ru');
    assert.equal(first.storySourceUrl, 'https://ru.wikipedia.org/wiki/x', 'ссылка — на статью на языке маршрута');

    // Дом без статьи: статья на другом языке и справка вместе.
    const house = route.points.find((p: any) => p.name === 'Дом Кочубея');
    const res = (await call('POST', `/api/points/${house.id}/story`, token, {})).json;
    const source = stories.at(-1)!.source!;
    assert.match(source, /Статья Википедии на другом языке \(en\):\nA mansion built in 1910/);
    assert.match(source, /Справка:\n[\s\S]*Архитектор: Мельцер/);
    const point = res.route.points.find((p: any) => p.id === house.id);
    assert.equal(point.storySource, 'ai_sourced');
    assert.equal(point.storySourceUrl, 'https://en.wikipedia.org/wiki/Kochubey_House');
  });

  test('длинная статья: статья на другом языке не запрашивается, справка добавляется', async () => {
    let asked = 0;
    geo = fakeGeo({
      wikiExtract: async () => ({ text: 'Очень подробно. '.repeat(400), url: 'https://ru.wikipedia.org/wiki/x' }),
      otherArticle: async () => {
        asked++;
        return null;
      },
      placeFacts: async () => ({ label: 'Место', description: 'дворец', url: 'https://www.wikidata.org/wiki/Q1', facts: [{ label: 'Стиль', value: 'барокко' }] }),
    });
    await start();
    const { token } = await register();
    const route = (await generate(token)).json.route;
    const place1 = route.points.find((p: any) => p.name === 'Место 1');
    await call('POST', `/api/points/${place1.id}/story`, token, {});
    assert.equal(asked, 0);
    assert.match(stories.at(-1)!.source!, /^Очень подробно[\s\S]*Справка:\n[\s\S]*Стиль: барокко$/);
  });

  test('место без статьи и без ИИ: короткая справка', async () => {
    ai = null;
    await start();
    const { token } = await register();
    const route = (await generate(token)).json.route;
    const house = route.points.find((p: any) => p.name === 'Дом Кочубея');
    const point = (await call('POST', `/api/points/${house.id}/story`, token, {})).json.route.points.find((p: any) => p.id === house.id);
    assert.equal(point.storySource, 'facts');
    assert.match(point.story, /^Дом Кочубея — особняк в Санкт-Петербурге\./);
    assert.match(point.story, /Архитектор — Мельцер\./);
    assert.match(point.story, /номер в реестре 781720744490005/);
  });

  test('готовый рассказ и озвучка о месте переиспользуются в чужом маршруте', async () => {
    await start();
    const a = await register();
    const routeA = (await generate(a.token)).json.route;
    const storyA = (await call('POST', `/api/points/${routeA.points[0].id}/story`, a.token, {})).json;
    assert.equal(storyA.reused, false);
    assert.equal(stories.length, 1);
    assert.equal(ttsCalls, 1);
    const pointA = storyA.route.points[0];

    const b = await register();
    const routeB = (await generate(b.token)).json.route;
    const storyB = (await call('POST', `/api/points/${routeB.points[0].id}/story`, b.token, {})).json;
    assert.equal(storyB.reused, true);
    assert.equal(stories.length, 1, 'ИИ не вызывался');
    assert.equal(ttsCalls, 1, 'озвучка скопирована, а не синтезирована');
    const pointB = storyB.route.points[0];
    assert.equal(pointB.story, pointA.story);
    assert.equal(pointB.storySource, pointA.storySource);
    assert.notEqual(pointB.narrationUrl, pointA.narrationUrl, 'у каждой точки свой файл');
    const file = (url: string) => readFileSync(path.join(sub, 'uploads', path.basename(url)), 'utf8');
    assert.equal(file(pointB.narrationUrl), file(pointA.narrationUrl));

    // Удаление маршрута A не ломает озвучку B.
    assert.equal((await call('DELETE', `/api/routes/${routeA.id}`, a.token)).status, 204);
    assert.equal(file(pointB.narrationUrl), `mp3:${pointA.story}`);

    // «Создать заново» пишет новый текст.
    const fresh = (await call('POST', `/api/points/${routeB.points[0].id}/story`, b.token, { fresh: true })).json;
    assert.equal(fresh.reused, false);
    assert.equal(stories.length, 2);
    assert.notEqual(fresh.route.points[0].story, pointA.story);
  });

  test('переиспользование: рассказы прежнего, короткого формата не берутся', async () => {
    await start();
    const a = await register();
    const routeA = (await generate(a.token)).json.route;
    await call('POST', `/api/points/${routeA.points[0].id}/story`, a.token, {});
    // Рассказ, написанный до удвоения объёма.
    const db = openDb(path.join(sub, 'db.sqlite'));
    db.prepare('UPDATE points SET story_version = NULL WHERE id = ?').run(routeA.points[0].id);
    db.close();

    const b = await register();
    const routeB = (await generate(b.token)).json.route;
    const res = (await call('POST', `/api/points/${routeB.points[0].id}/story`, b.token, {})).json;
    assert.equal(res.reused, false);
    assert.equal(stories.length, 2);
  });

  test('переиспользование: только то же направление, не тексты автора, озвучка — только тем же голосом', async () => {
    await start();
    const a = await register();
    const routeA = (await generate(a.token)).json.route;
    const [p1] = routeA.points;
    await call('POST', `/api/points/${p1.id}/story`, a.token, {});

    const b = await register();
    const routeB = (await generate(b.token)).json.route;
    // Другое направление — новый рассказ.
    const legends = (await call('POST', `/api/points/${routeB.points[0].id}/story`, b.token, { style: 'legends' })).json;
    assert.equal(legends.reused, false);
    assert.equal(stories.length, 2);

    // Автор переписал текст — такой рассказ личный.
    await call('PATCH', `/api/points/${p1.id}`, a.token, { story: 'Мой собственный текст' });
    const c = await register();
    const routeC = (await generate(c.token)).json.route;
    const res = (await call('POST', `/api/points/${routeC.points[0].id}/story`, c.token, {})).json;
    assert.equal(res.reused, false);
    assert.notEqual(res.route.points[0].story, 'Мой собственный текст');
  });

  test('переиспользование: озвучка другим голосом синтезируется заново, текст берётся готовый', async () => {
    await start();
    const a = await register();
    const routeA = (await generate(a.token)).json.route;
    await call('POST', `/api/points/${routeA.points[0].id}/story`, a.token, {});
    const db = new DatabaseSync(path.join(sub, 'db.sqlite'));
    db.prepare("UPDATE media SET voice = 'старый голос'").run();
    db.close();

    const b = await register();
    const routeB = (await generate(b.token)).json.route;
    const res = (await call('POST', `/api/points/${routeB.points[0].id}/story`, b.token, {})).json;
    assert.equal(res.reused, true);
    assert.equal(stories.length, 1);
    assert.equal(ttsCalls, 2);
  });

  test('превью ссылки: открытый маршрут с метатегами и фото, приватный — без них', async () => {
    const web = path.join(dir, 'index.html');
    writeFileSync(web, '<!doctype html><html><head><title>Для прогулок</title></head><body><div id="root"></div></body></html>');
    await start({ web });
    const { token } = await register();
    const route = (await generate(token)).json.route;

    const hidden = await call('GET', `/route/${route.id}`);
    assert.equal(hidden.status, 200);
    assert.doesNotMatch(hidden.body, /og:title|Петербург/, 'название приватного маршрута не раскрывается');

    await call('PATCH', `/api/routes/${route.id}`, token, { isPublic: true });
    const page = await call('GET', `/route/${route.id}`);
    assert.match(page.body, /<title>Петербург &lt;наследия&gt; · Для прогулок<\/title>/);
    assert.match(page.body, /<meta property="og:title" content="Петербург &lt;наследия&gt;" \/>/);
    assert.match(page.body, new RegExp(`og:url" content="https://dlyaprogulok.ru/route/${route.id}"`));
    assert.match(page.body, /og:image" content="https:\/\/upload\.wikimedia\.org\//, 'фото первой точки с картинкой');
    assert.match(page.body, /og:description" content="[\d,]+ км · .* · 2 места\. Санкт-Петербург\. Описание"/);
    assert.match(page.body, /<div id="root">/, 'само приложение на месте');

    assert.equal((await call('GET', '/route/not-a-uuid')).status, 200);
    assert.equal(readdirSync(dir).includes('index.html'), true);
  });

  test('миграция: у старых пользователей почта считается подтверждённой', () => {
    const file = path.join(mkdtempSync(path.join(dir, 'm-')), 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u1', 'old@example.com', 'Старый', 'x:y', '2026-11-01T00:00:00.000Z');
    old.close();
    const db = openDb(file);
    assert.equal((db.prepare('SELECT email_verified_at FROM users').get() as any).email_verified_at, '2026-11-01T00:00:00.000Z');
    db.close();
  });

  test('сброс пароля: письмо со ссылкой, одинаковый ответ для чужого адреса, новый пароль закрывает сессии', async () => {
    await start({ mail: true });
    const { token, user } = await register();
    mails.length = 0;
    const unknown = await call('POST', '/api/auth/forgot', undefined, { email: 'nobody@example.com' });
    assert.equal(unknown.status, 200);
    assert.equal(mails.length, 0);
    const res = await call('POST', '/api/auth/forgot', undefined, { email: user.email.toUpperCase() });
    assert.deepEqual(res.json, unknown.json, 'ответ не выдаёт, есть ли такой адрес');
    assert.equal(mails.length, 1);
    assert.match(mails[0]!.subject, /Сброс пароля/);
    const link = mails[0]!.text.match(/https:\/\/dlyaprogulok\.ru\/reset\?token=(\S+)/);
    assert.ok(link, mails[0]!.text);

    assert.equal((await call('POST', '/api/auth/reset', undefined, { token: 'x'.repeat(30), password: 'new password 1' })).status, 400);
    assert.equal((await call('POST', '/api/auth/reset', undefined, { token: link[1], password: 'short' })).status, 400);
    const done = await call('POST', '/api/auth/reset', undefined, { token: link[1], password: 'new password 1' });
    assert.equal(done.status, 200);
    assert.ok(done.json.token);
    assert.equal(done.json.user.emailVerified, true, 'доступ к почте подтверждён');
    assert.equal((await call('GET', '/api/me', token)).status, 401, 'старые сессии закрыты');
    assert.equal((await call('POST', '/api/auth/reset', undefined, { token: link[1], password: 'again password' })).status, 400, 'ссылка одноразовая');
    assert.equal((await call('POST', '/api/auth/login', undefined, { email: user.email, password: 'new password 1' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', undefined, { email: user.email, password: 'correct horse' })).status, 401);
  });

  test('сброс пароля без почтового сервиса недоступен', async () => {
    await start();
    assert.equal((await call('POST', '/api/auth/forgot', undefined, { email: 'a@example.com' })).status, 409);
  });

  test('удаление аккаунта: нужен пароль; маршруты и файлы удаляются', async () => {
    await start();
    const { token } = await register();
    const route = (await generate(token)).json.route;
    await call('POST', `/api/points/${route.points[0].id}/story`, token, {});
    const narration = (await call('GET', `/api/routes/${route.id}`, token)).json.route.points[0].narrationUrl;
    assert.ok(narration);
    assert.equal((await call('DELETE', '/api/me', token, { password: 'wrong' })).status, 403);
    assert.equal((await call('DELETE', '/api/me', token, { password: 'correct horse' })).status, 204);
    assert.equal((await call('GET', '/api/me', token)).status, 401);
    assert.equal((await app.inject({ method: 'GET', url: narration })).statusCode, 404, 'озвучка удалена');
    assert.equal((await call('GET', `/api/routes/${route.id}`)).status, 404);
  });
});

describe('Викимедиа: разбор ответов', () => {
  /** Подставной getJson: по подстроке адреса возвращает заготовленный ответ и запоминает запросы. */
  const fakeJson = (routes: [string, unknown][]) => {
    const urls: string[] = [];
    const getJson = async (url: string) => {
      // URLSearchParams кодирует пробел как «+».
      const plain = decodeURIComponent(url.replace(/\+/g, ' '));
      urls.push(plain);
      const hit = routes.find(([key]) => plain.includes(key));
      if (!hit) throw new Error(`нет ответа для ${url}`);
      return hit[1];
    };
    return { urls, getJson };
  };

  test('имена файлов Commons из Викиданных, OSM и ссылок', () => {
    assert.equal(commonsFileName('File:Dom_Kochubey.jpg'), 'Dom Kochubey.jpg');
    assert.equal(commonsFileName('http://commons.wikimedia.org/wiki/Special:FilePath/Dom%20Kochubey.jpg'), 'Dom Kochubey.jpg');
    assert.equal(commonsFileName('Category:Kochubey'), null);
    assert.equal(commonsFileName('File:План.pdf'), null);
  });

  test('автор из HTML и обрезка длинных строк', () => {
    assert.equal(plainText('<a href="//commons.wikimedia.org/wiki/User:Ivan">Ivan&nbsp;Petrov</a> &amp; Co'), 'Ivan Petrov & Co');
    assert.equal(plainText('<span></span>'), null);
    assert.equal(plainText('x'.repeat(200))!.length, 118);
  });

  test('даты Викиданных по точности', () => {
    assert.equal(formatWikidataTime({ time: '+1801-00-00T00:00:00Z', precision: 9 }), '1801');
    assert.equal(formatWikidataTime({ time: '+1880-00-00T00:00:00Z', precision: 8 }), '1880-е');
    assert.equal(formatWikidataTime({ time: '+1850-00-00T00:00:00Z', precision: 7 }), 'XIX век');
    assert.equal(formatWikidataTime({ time: '+1912-05-07T00:00:00Z', precision: 11 }), '7.05.1912');
    assert.equal(formatWikidataTime({ time: '-0500-00-00T00:00:00Z', precision: 9 }), null);
  });

  test('фото Commons: нормализация названий, ссылки без utm, автор и лицензия', async () => {
    const { getJson } = fakeJson([
      [
        'commons.wikimedia.org',
        {
          query: {
            normalized: [{ from: 'File:Dom_Kochubey.jpg', to: 'File:Dom Kochubey.jpg' }],
            pages: [
              {
                title: 'File:Dom Kochubey.jpg',
                imageinfo: [
                  {
                    thumburl: 'https://upload.wikimedia.org/x/800px-Dom.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo',
                    thumbwidth: 800,
                    thumbheight: 600,
                    url: 'https://upload.wikimedia.org/x/Dom.jpg',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Dom_Kochubey.jpg',
                    extmetadata: {
                      Artist: { value: '<a href="x">Иван</a>' },
                      LicenseShortName: { value: 'CC BY-SA 4.0' },
                      LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
                    },
                  },
                ],
              },
              { title: 'File:Нет.jpg', missing: true },
            ],
          },
        },
      ],
    ]);
    const photos = await commonsPhotos(['Dom Kochubey.jpg', 'Нет.jpg'], getJson);
    const photo = photos.get('Dom Kochubey.jpg')!;
    assert.equal(photo.url, 'https://upload.wikimedia.org/x/800px-Dom.jpg');
    assert.equal(photo.author, 'Иван');
    assert.equal(photo.license, 'CC BY-SA 4.0');
    assert.equal(photos.has('Нет.jpg'), false);
  });

  test('поиск фото: статья → свободная картинка и Q-id; Q-id без картинки → P18', async () => {
    const imageinfo = (title: string) => ({
      title,
      imageinfo: [{ thumburl: `https://upload/${title}`, descriptionurl: `https://commons/${title}`, extmetadata: {} }],
    });
    const { urls, getJson } = fakeJson([
      [
        'ru.wikipedia.org',
        {
          query: {
            redirects: [{ from: 'Старое название', to: 'Казанский собор' }],
            pages: [{ title: 'Казанский собор', pageprops: { wikibase_item: 'Q404571', page_image_free: 'Kazan_Cathedral.jpg' } }],
          },
        },
      ],
      ['wbgetentities', { entities: { Q42: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Dom.jpg' } } }] } } } }],
      ['commons.wikimedia.org', { query: { pages: [imageinfo('File:Kazan Cathedral.jpg'), imageinfo('File:Dom.jpg')] } }],
    ]);
    const res = await findPhotos(
      [{ wikiTitle: 'Старое название' }, { wikidata: 'Q42' }, { wikiTitle: null }],
      'ru',
      'ru.wikipedia.org',
      getJson,
    );
    assert.equal(res[0]!.wikidata, 'Q404571');
    assert.equal(res[0]!.photo!.url, 'https://upload/File:Kazan Cathedral.jpg');
    assert.equal(res[1]!.photo!.url, 'https://upload/File:Dom.jpg');
    assert.deepEqual(res[2], { wikidata: null, photo: null });
    assert.equal(urls.filter((u) => u.includes('commons')).length, 1, 'все файлы одним запросом');
  });

  test('справка Викиданных: подписи связанных элементов, даты, номер реестра', async () => {
    const item = (id: string) => ({ mainsnak: { datavalue: { value: { id } } }, rank: 'normal' });
    const { getJson } = fakeJson([
      [
        'ids=Q42&props=claims|labels|descriptions',
        {
          entities: {
            Q42: {
              labels: { ru: { value: 'Особняк Кочубея' } },
              descriptions: { ru: { value: 'особняк в Санкт-Петербурге' } },
              claims: {
                P571: [{ mainsnak: { datavalue: { value: { time: '+1910-00-00T00:00:00Z', precision: 9 } } }, rank: 'normal' }],
                P84: [item('Q1'), item('Q2')],
                P1435: [item('Q3')],
                P5381: [{ mainsnak: { datavalue: { value: '781720744490005' } }, rank: 'normal' }],
                P149: [{ ...item('Q9'), rank: 'deprecated' }],
              },
            },
          },
        },
      ],
      [
        'props=labels',
        {
          entities: {
            Q1: { labels: { ru: { value: 'Мельцер' } } },
            Q2: { labels: { ru: { value: 'Шуко' } } },
            Q3: { labels: { ru: { value: 'объект культурного наследия регионального значения' } } },
          },
        },
      ],
    ]);
    const facts = await wikidataFacts('Q42', 'ru', getJson);
    assert.equal(facts!.description, 'особняк в Санкт-Петербурге');
    assert.deepEqual(facts!.facts, [
      { label: 'Создан', value: '1910' },
      { label: 'Архитектор', value: 'Мельцер, Шуко' },
      { label: 'Охранный статус', value: 'объект культурного наследия регионального значения' },
      { label: 'Номер в реестре ЕГРОКН', value: '781720744490005' },
    ]);
    assert.equal(await wikidataFacts('not-an-id', 'ru', getJson), null);
  });

  test('объекты наследия рядом: координаты, общие названия частей ансамбля, фото', async () => {
    const { urls, getJson } = fakeJson([
      [
        'query.wikidata.org',
        {
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q100' },
                name: { value: 'Собор' },
                part: { value: 'Ансамбль Казанского собора' },
                c: { value: 'Point(30.3245 59.9343)' },
                egrokn: { value: '781510398760006' },
                image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Kazan%20Cathedral.jpg' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q200' },
                name: { value: 'Дом страхового общества «Россия»' },
                c: { value: 'Point(30.3390 59.9405)' },
                wiki: { value: 'Дом страхового общества «Россия»' },
              },
              // Дальше радиуса — отбрасывается.
              { item: { value: 'http://www.wikidata.org/entity/Q300' }, name: { value: 'Далеко' }, c: { value: 'Point(31 60)' } },
            ],
          },
        },
      ],
    ]);
    const places = await heritageNearby(START, 1500, 'ru', getJson);
    assert.deepEqual(
      places.map((p) => [p.wikidata, p.name, p.heritageRef, p.commonsFile, p.wikiTitle]),
      [
        ['Q100', 'Собор (Ансамбль Казанского собора)', '781510398760006', 'Kazan Cathedral.jpg', undefined],
        ['Q200', 'Дом страхового общества «Россия»', undefined, undefined, 'Дом страхового общества «Россия»'],
      ],
    );
    assert.match(urls[0]!, /wikibase:radius "1\.50"/);
    assert.match(urls[0]!, /Point\(30\.338 59\.94\)/);
  });

  test('объекты наследия сливаются с OSM и Википедией по Q-id', () => {
    const osm = [cand(1, 0.001, 0, { id: 'osm:way/1', name: 'Особняк', wikiTitle: undefined, wikidata: 'Q42' })];
    const heritage = heritageCandidates(
      [
        { wikidata: 'Q42', name: 'Особняк Кочубея', lat: START.lat + 0.01, lng: START.lng, heritageRef: '7817', commonsFile: 'Dom.jpg' },
        { wikidata: 'Q7', name: 'Доходный дом', lat: START.lat, lng: START.lng + 0.002 },
      ],
      START,
    );
    const merged = mergeCandidates(osm, [], heritage);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.heritageRef, '7817');
    assert.equal(merged[0]!.commonsFile, 'Dom.jpg');
    assert.equal(merged[1]!.id, 'wd:Q7');
    assert.equal(merged[1]!.kind, 'heritage');
    assert.equal(merged[1]!.about, 'объект культурного наследия');
  });

  test('справка из тегов OSM и сборка рассказа без ИИ', () => {
    const facts = osmFacts({ start_date: '1910', architect: 'Мельцер', 'ref:okn': '781720744490005', 'addr:street': 'Фурштатская улица', 'addr:housenumber': '24' });
    assert.deepEqual(facts.map((f) => f.label), ['Создан', 'Архитектор', 'Номер в реестре ЕГРОКН', 'Охранный статус', 'Адрес']);
    const merged = mergeFacts([{ label: 'Охранный статус', value: 'объект культурного наследия федерального значения' }], facts);
    assert.equal(merged.find((f) => f.label === 'Охранный статус')!.value, 'объект культурного наследия федерального значения');
    assert.equal(
      factsStory('Дом Кочубея', null, merged),
      'Дом Кочубея. Время создания: 1910. Архитектор — Мельцер. Охраняется государством: объект культурного наследия федерального значения, номер в реестре 781720744490005.',
    );
  });
});

describe('почта и превью', () => {
  test('почтовый сервис из окружения', () => {
    assert.equal(createMailerFromEnv({}), null);
    assert.throws(() => createMailerFromEnv({ SMTP_URL: 'smtps://u:p@smtp.yandex.ru:465' }), /MAIL_FROM/);
    assert.equal(createMailerFromEnv({ SMTP_URL: 'smtps://u:p@smtp.yandex.ru:465', MAIL_FROM: 'a@b.ru' })!.name, 'SMTP smtp.yandex.ru');
    assert.throws(() => createMailerFromEnv({ MAIL_TRANSPORT: 'pigeon' }), /только log/);
  });

  test('почта в лог для разработки', async () => {
    const lines: string[] = [];
    const mailer = createMailerFromEnv({ MAIL_TRANSPORT: 'log' }, (m) => lines.push(m))!;
    await mailer.send(verificationMail('a@b.ru', 'Аня', 'https://x/verify?token=abc'));
    assert.match(lines[0]!, /a@b\.ru/);
    assert.match(lines[0]!, /https:\/\/x\/verify\?token=abc/);
  });

  test('письмо экранирует имя в HTML', () => {
    const mail = verificationMail('a@b.ru', '<script>Аня</script>', 'https://x/verify?token=a&b');
    assert.doesNotMatch(mail.html, /<script>/);
    assert.match(mail.html, /href="https:\/\/x\/verify\?token=a&amp;b"/);
    assert.match(mail.text, /<script>Аня<\/script>, здравствуйте!/);
  });

  test('метатеги: экранирование, обрезка, заголовок', () => {
    const html = injectShareMeta('<html><head><title>Для прогулок</title></head><body></body></html>', {
      title: 'Маршрут "с кавычками" & <тегами>',
      description: 'a\n\nb '.repeat(200),
      url: 'https://dlyaprogulok.ru/route/1',
    });
    assert.match(html, /<title>Маршрут &quot;с кавычками&quot; &amp; &lt;тегами&gt; · Для прогулок<\/title>/);
    assert.doesNotMatch(html, /og:image/);
    assert.match(html, /twitter:card" content="summary"/);
    const description = html.match(/og:description" content="([^"]*)"/)![1]!;
    assert.ok(description.length <= 300);
    assert.ok(description.endsWith('…'));
  });

  test('сводка маршрута для превью', () => {
    assert.equal(routeFacts(2440, 70, 6), '2,4 км · 1 ч 10 мин · 6 мест');
    assert.equal(routeFacts(900, 45, 1), '0,9 км · 45 мин · 1 место');
    assert.equal(routeFacts(5000, 120, 3), '5,0 км · 2 ч · 3 места');
    assert.equal(routeFacts(5000, 120, 12), '5,0 км · 2 ч · 12 мест');
  });
});
