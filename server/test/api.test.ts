import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

process.env.NODE_ENV = 'test';

import type { AI } from '../src/ai.ts';
import { createDeepSeekAI } from '../src/ai-deepseek.ts';
import { createAiFromEnv } from '../src/ai-provider.ts';
import { createTts, createTtsFromEnv, createYandexTts, splitText, stripId3 } from '../src/tts.ts';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { computeBudget, haversine, orderStops, pathLength } from '../src/geo.ts';
import { planRoute, rankCandidates, selectHeuristic } from '../src/planner.ts';
import { contentDisposition, toGpx, xml } from '../src/export.ts';
import { backfillCities } from '../src/cities.ts';
import { bestInsertion } from '../src/geo.ts';
import { storySystem, stripNoLegendsNote } from '../src/ai.ts';
import { legendSections, legendsSource, mergeCandidates, realGeoServices, sameTitle, type Candidate, type GeoServices } from '../src/services.ts';

const START = { lat: 55.7539, lng: 37.6208 };

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

const CANDIDATES = [
  cand(1, 0.002, 0),
  cand(2, 0.002, 0.003),
  cand(3, 0, 0.004),
  cand(4, -0.002, 0.002),
  cand(5, -0.003, -0.002),
  cand(6, 0.03, 0.03), // далеко: не влезает в короткий бюджет
];

const fakeGeo = (over: Partial<GeoServices> = {}): GeoServices => ({
  findCandidates: async () => CANDIDATES,
  walkPath: async (start, stops, roundTrip) => {
    const pts = roundTrip ? [start, ...stops, start] : [start, ...stops];
    return {
      distanceM: Math.round(pathLength(start, stops, roundTrip) * 1.3),
      geometry: pts.map((p) => [p.lat, p.lng]),
      routed: true,
    };
  },
  geocode: async (q) => [{ name: q, ...START }],
  wikiExtract: async (title) => ({
    text: `${title} — известное место. Здесь много истории.\n== Раздел ==\nЛишнее`,
    url: 'https://ru.wikipedia.org/wiki/x',
  }),
  findArticle: async () => null,
  placePhotos: async (items) => items.map((i) => ({ wikidata: i.wikidata ?? null, photo: null })),
  placeFacts: async () => null,
  otherArticle: async () => null,
  reverseCity: async () => 'Москва',
  searchCities: async (q) => [{ name: q, region: 'Россия', ...START }],
  ...over,
});

const fakeAi = (over: Partial<AI> = {}): AI => ({
  selectStops: async () => ({
    title: 'Тихий центр',
    description: 'Описание',
    stops: [
      { candidateId: 'c1', teaser: 'Первая' },
      { candidateId: 'c3', teaser: 'Вторая' },
      { candidateId: 'c1', teaser: 'Дубль' },
      { candidateId: 'выдумка', teaser: 'Нет в списке' },
    ],
  }),
  writeStory: async ({ name }) => `Рассказ о месте ${name}`,
  ...over,
});

const selectInput = {
  start: { lat: 55.75, lng: 37.62 },
  candidates: [],
  walkMeters: 2000,
  maxStops: 3,
  roundTrip: false,
  lang: 'ru',
};

/** DeepSeek без сети: ответы выдаются по очереди, запросы запоминаются. */
function fakeDeepSeek(replies: (Response | { content: string; finish?: string })[]) {
  const calls: { url: string; headers: any; body: any }[] = [];
  const queue = [...replies];
  const ai = createDeepSeekAI({
    apiKey: 'test-key',
    model: 'deepseek-flash',
    baseUrl: 'https://deepseek.test/',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      const next = queue.shift();
      if (!next) throw new Error('лишний запрос');
      if (next instanceof Response) return next;
      return Response.json({
        choices: [{ finish_reason: next.finish ?? 'stop', message: { content: next.content } }],
      });
    }) as typeof fetch,
  });
  return { ai, calls };
}

const validSelection = JSON.stringify({
  title: 'Заголовок',
  description: 'Описание',
  stops: [{ candidate_id: 'c1', teaser: 'Фраза' }],
});

describe('DeepSeek', () => {
  test('отбор: запрос в режиме JSON, ответ приводится к общему виду', async () => {
    const { ai, calls } = fakeDeepSeek([{ content: validSelection }]);
    const res = await ai.selectStops(selectInput);
    assert.deepEqual(res.stops, [{ candidateId: 'c1', teaser: 'Фраза' }]);
    assert.equal(calls[0]!.url, 'https://deepseek.test/chat/completions');
    assert.equal(calls[0]!.headers.Authorization, 'Bearer test-key');
    assert.equal(calls[0]!.body.model, 'deepseek-flash');
    assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' });
    assert.match(calls[0]!.body.messages[0].content, /JSON/);
  });

  test('пустой ответ в режиме JSON повторяется', async () => {
    const { ai, calls } = fakeDeepSeek([{ content: '   ' }, { content: validSelection }]);
    assert.equal((await ai.selectStops(selectInput)).title, 'Заголовок');
    assert.equal(calls.length, 2);
  });

  test('ответ не по схеме после повтора — ошибка, а не мусор в маршруте', async () => {
    const { ai, calls } = fakeDeepSeek([{ content: '{"title":1}' }, { content: '{"stops":"нет"}' }]);
    await assert.rejects(ai.selectStops(selectInput), /не по схеме/);
    assert.equal(calls.length, 2);
  });

  test('обрезанный ответ и фильтр контента — ошибка', async () => {
    const cut = fakeDeepSeek([{ content: '{"ti', finish: 'length' }]);
    await assert.rejects(cut.ai.selectStops(selectInput), /обрезан/);
    const filtered = fakeDeepSeek([{ content: '', finish: 'content_filter' }]);
    await assert.rejects(filtered.ai.writeStory({ name: 'Храм', lang: 'ru' }), /фильтр/);
  });

  test('перегрузка повторяется, а нехватка денег нет', async () => {
    const busy = fakeDeepSeek([new Response('', { status: 503 }), { content: 'Рассказ' }]);
    assert.equal(await busy.ai.writeStory({ name: 'Храм', lang: 'ru' }), 'Рассказ');
    const broke = fakeDeepSeek([
      Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 }),
    ]);
    await assert.rejects(broke.ai.writeStory({ name: 'Храм', lang: 'ru' }), /402: Insufficient Balance/);
    assert.equal(broke.calls.length, 1);
  });

  test('рассказ о легендах уходит с промптом для легенд', async () => {
    const { ai, calls } = fakeDeepSeek([{ content: 'Говорят…' }]);
    await ai.writeStory({ name: 'Башня', lang: 'ru', style: 'legends' });
    assert.match(calls[0]!.body.messages[0].content, /Не сочиняй легенд/);
    assert.match(calls[0]!.body.messages[1].content, /Направление: мифы, легенды и предания/);
  });

  test('рассказ идёт обычным текстом, без режима JSON', async () => {
    const { ai, calls } = fakeDeepSeek([{ content: '  Рассказ о храме. ' }]);
    assert.equal(await ai.writeStory({ name: 'Храм', lang: 'ru' }), 'Рассказ о храме.');
    assert.equal(calls[0]!.body.response_format, undefined);
  });
});

const ARTICLE = [
  'Башня построена в XVII веке.',
  '',
  '== История ==',
  'Перестраивалась дважды.',
  '',
  '== Легенды ==',
  'Говорят, в подвале спрятана библиотека.',
  '',
  '=== Призрак ===',
  'По ночам на верхнем ярусе видят огонёк.',
  '',
  '== Ссылки ==',
  'Сайт музея',
].join('\n');

describe('поиск мест: сбой источников', () => {
  const withFetch = async (impl: (url: string) => Response | Promise<Response>, fn: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => impl(String(input))) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  };

  test('Википедия упала, Overpass пуст — это сбой, а не «рядом ничего нет»', async () => {
    let wikiCalls = 0;
    await withFetch(
      (url) => {
        if (url.includes('.wikipedia.org/w/api.php')) {
          wikiCalls++;
          return new Response('', { status: 503 });
        }
        return Response.json({ elements: [] });
      },
      async () => {
        await assert.rejects(realGeoServices.findCandidates(START, 800, 'ru'), /недоступны/);
      },
    );
    assert.equal(wikiCalls, 2, 'Википедия запрашивается повторно');
  });

  test('Overpass с ошибкой в remark считается сбоем', async () => {
    await withFetch(
      (url) =>
        url.includes('wikipedia')
          ? new Response('', { status: 503 })
          : Response.json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1' }),
      async () => {
        await assert.rejects(realGeoServices.findCandidates(START, 800, 'ru'), /недоступны/);
      },
    );
  });
});

describe('мифы и легенды', () => {
  test('из статьи берётся раздел о легендах вместе с подразделами', () => {
    const [section, ...rest] = legendSections(ARTICLE);
    assert.equal(rest.length, 0);
    assert.match(section!, /библиотека/);
    assert.match(section!, /огонёк/, 'подраздел внутри легенд');
    assert.doesNotMatch(section!, /Перестраивалась|Сайт музея/);
  });

  test('источник для легенд: вступление и легенды; без легенд — начало статьи', () => {
    const withLegends = legendsSource(ARTICLE);
    assert.equal(withLegends.hasLegends, true);
    assert.match(withLegends.text, /^Башня построена/);
    assert.match(withLegends.text, /библиотека/);
    assert.doesNotMatch(withLegends.text, /Сайт музея/);
    const plain = legendsSource('Просто здание.\n== История ==\nТекст');
    assert.equal(plain.hasLegends, false);
  });

  test('оговорка «легенд не знаю» вырезается, сами легенды остаются', () => {
    const removed = [
      'Честно скажу сразу: легенд об этом мосте я не знаю.',
      'Легенд об этом месте не сохранилось.',
      'Мне не известны легенды об этой церкви.',
      'Особых преданий о доме нет.',
      'Легенды об этом мосте мне не встречались.',
      'Увы, мифов об этой башне не удалось найти.',
    ];
    for (const note of removed) {
      const text = `${note} Мост построили в 1850 году по проекту Кербедза.\n\nТеперь он главный в городе.`;
      assert.equal(stripNoLegendsNote(text), 'Мост построили в 1850 году по проекту Кербедза.\n\nТеперь он главный в городе.', note);
    }
    const kept = [
      'По преданию, здесь нет ни одного гвоздя.',
      'Легенда гласит, что клад так и не нашли.',
      'Местные легенды уверяют, что от дворца ничего не сохранилось.',
      'Говорят, призрака никто не встречал уже сто лет.',
      'Мост построили в 1850 году.',
    ];
    for (const sentence of kept) assert.equal(stripNoLegendsNote(`${sentence} Дальше рассказ.`), `${sentence} Дальше рассказ.`, sentence);
    // Весь текст — оговорка: лучше оставить его, чем отдать пустой рассказ.
    assert.equal(stripNoLegendsNote('Легенд об этом месте я не знаю.'), 'Легенд об этом месте я не знаю.');
  });

  test('промпт: легенды подаются как легенды и не сочиняются', () => {
    assert.match(storySystem('legends'), /Не сочиняй легенд/);
    assert.match(storySystem('legends'), /по преданию/);
    assert.doesNotMatch(storySystem('facts'), /Не сочиняй легенд/);
    assert.match(storySystem('legends'), /Не упоминай, что легенд нет/);
    assert.doesNotMatch(storySystem('legends'), /честно скажи/);
    assert.match(storySystem(), /Направление рассказа — факты/);
  });
});

describe('экспорт и вспомогательное', () => {
  test('экранирование XML и недопустимые символы', () => {
    assert.equal(xml(`a<b>&"c'\u0001`), 'a&lt;b&gt;&amp;&quot;c&apos;');
  });

  test('имя файла: кириллица в filename*, латиница в запасном', () => {
    const h = contentDisposition('Прогулка: «Арбат»/Kremlin', 'gpx');
    assert.match(h, /filename="Kremlin\.gpx"/);
    assert.ok(h.includes(`filename*=UTF-8''${encodeURIComponent('Прогулка «Арбат» Kremlin.gpx')}`));
    assert.match(contentDisposition('Тверь', 'kml'), /filename="route\.kml"/);
  });

  test('GPX без линии по улицам рисует прямые и замыкает кольцо', () => {
    const gpx = toGpx({
      title: 'T',
      description: '',
      roundTrip: true,
      start: { lat: 1, lng: 2, label: null },
      finish: null,
      geometry: [],
      points: [{ name: 'A', teaser: '', lat: 3, lng: 4 }],
    });
    assert.equal((gpx.match(/<trkpt /g) ?? []).length, 3);
  });

  test('вставка точки: в середину, если она по пути', () => {
    const start = { lat: 0, lng: 0 };
    const stops = [{ lat: 0, lng: 0.01 }, { lat: 0, lng: 0.02 }];
    assert.equal(bestInsertion(start, stops, { lat: 0, lng: 0.015 }, false), 1);
    assert.equal(bestInsertion(start, stops, { lat: 0, lng: 0.03 }, false), 2);
  });

  test('фоновое определение города: дописывает пустые, останавливается при сбое сети', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-city-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'e', 'n', 'h', 't')").run();
    const ins = db.prepare(
      `INSERT INTO routes (id, owner_id, title, description, lang, round_trip, start_lat, start_lng, distance_m, duration_min, geometry, planner, created_at, updated_at, city)
       VALUES (?, 'u', 't', '', 'ru', 0, 55, 37, 1, 1, '[]', 'ai', 't', 't', ?)`,
    );
    ins.run('a', null);
    ins.run('b', null);
    ins.run('c', 'Тверь');
    const log = { info() {}, warn() {} };
    let calls = 0;
    const done = await backfillCities(db, { ...fakeGeo(), reverseCity: async () => (++calls === 1 ? 'Москва' : null) }, log, 0);
    assert.equal(done, 2);
    const city = (id: string) => (db.prepare('SELECT city FROM routes WHERE id = ?').get(id) as any).city;
    assert.equal(city('a'), 'Москва');
    assert.equal(city('b'), '', 'не нашли — помечаем, чтобы не спрашивать снова');
    assert.equal(city('c'), 'Тверь');

    db.prepare("UPDATE routes SET city = NULL WHERE id IN ('a', 'b')").run();
    const failed = await backfillCities(db, { ...fakeGeo(), reverseCity: async () => { throw new Error('сеть'); } }, log, 0);
    assert.equal(failed, 0);
    assert.equal(city('a'), null, 'при сбое остаётся на следующий запуск');
    rmSync(dir, { recursive: true, force: true });
  });

  test('миграция: старая база получает колонку city', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-mig-'));
    const file = path.join(dir, 'db.sqlite');
    const first = openDb(file);
    first.exec('DROP INDEX routes_city');
    // Индекс каталога появился позже колонки city: в старой базе его тоже нет.
    first.exec('DROP INDEX routes_catalog');
    first.exec('ALTER TABLE routes DROP COLUMN city');
    first.close();
    const again = openDb(file);
    const cols = (again.prepare('PRAGMA table_info(routes)').all() as any[]).map((c) => c.name);
    assert.ok(cols.includes('city'));
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('озвучка', () => {
  const recorder = (reply: Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply;
    }) as typeof fetch;
    return { calls, doFetch };
  };

  test('локальный контейнер: без ключа и без заголовка Authorization', async () => {
    const { calls, doFetch } = recorder(new Response(Buffer.from('ID3')));
    const tts = createTts({ baseUrl: 'http://localhost:8880/v1/', model: 'piper', voice: 'denis', fetch: doFetch });
    assert.equal((await tts.synthesize('Привет')).toString(), 'ID3');
    assert.equal(calls[0]!.url, 'http://localhost:8880/v1/audio/speech');
    assert.equal((calls[0]!.init.headers as any).Authorization, undefined);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { model: 'piper', voice: 'denis', input: 'Привет', response_format: 'mp3' });
  });

  test('ошибка сервиса передаёт его сообщение, пустой файл — ошибка', async () => {
    const bad = recorder(Response.json({ error: { message: 'неизвестный голос alloy' } }, { status: 400 }));
    const tts = createTts({ baseUrl: 'http://x/v1', model: 'm', voice: 'alloy', fetch: bad.doFetch });
    await assert.rejects(tts.synthesize('Привет'), /400: неизвестный голос alloy/);
    const empty = recorder(new Response(''));
    await assert.rejects(createTts({ baseUrl: 'http://x/v1', model: 'm', voice: 'v', fetch: empty.doFetch }).synthesize('Привет'), /пустой/);
  });

  test('включается по ключу или по адресу своего сервиса', () => {
    assert.equal(createTtsFromEnv({}), null);
    assert.ok(createTtsFromEnv({ TTS_BASE_URL: 'http://localhost:8880/v1' }));
    assert.ok(createTtsFromEnv({ TTS_API_KEY: 'k' }));
  });

  const ndjson = (...chunks: Buffer[]) =>
    new Response(chunks.map((c) => JSON.stringify({ result: { audioChunk: { data: c.toString('base64') }, chunkType: 'AUDIO_TEXT_COMBINED' } })).join('\n') + '\n');

  test('SpeechKit v3: запрос как в SDK AI Studio, поток кусков склеивается', async () => {
    const { calls, doFetch } = recorder(ndjson(Buffer.from('ID3head'), Buffer.from('-part2'), Buffer.from('-part3')));
    const tts = createYandexTts({ apiKey: 'ya-key', voice: 'alexander', role: 'good', speed: 1, folderId: 'b1gfolder', fetch: doFetch });
    assert.equal((await tts.synthesize(' Привет! ')).toString(), 'ID3head-part2-part3');
    assert.equal(calls[0]!.url, 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis');
    const headers = calls[0]!.init.headers as any;
    assert.equal(headers.Authorization, 'Api-Key ya-key');
    assert.equal(headers['x-folder-id'], 'b1gfolder');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      text: 'Привет!',
      hints: [{ voice: 'alexander' }, { role: 'good' }, { speed: 1 }],
      outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } },
      loudnessNormalizationType: 'LUFS',
      unsafeMode: true,
    });
    assert.equal(tts.name, 'Yandex SpeechKit v3, голос alexander (good)');
  });

  test('SpeechKit v3: ошибки без служебных id, пустой ответ — ошибка', async () => {
    const bad = recorder(Response.json({ error: { grpcCode: 3, httpCode: 400, message: 'Too long text, internal_id=abc&request_id=1' } }, { status: 400 }));
    await assert.rejects(createYandexTts({ apiKey: 'x', voice: 'alexander', fetch: bad.doFetch }).synthesize('Привет'), (err: Error) => {
      assert.equal(err.message, 'SpeechKit ответил 400: Too long text');
      return true;
    });
    const midStream = recorder(new Response(JSON.stringify({ result: { audioChunk: { data: 'QQ==' } } }) + '\n' + JSON.stringify({ error: { message: 'Internal' } })));
    await assert.rejects(createYandexTts({ apiKey: 'x', voice: 'alexander', fetch: midStream.doFetch }).synthesize('Привет'), /прервал синтез: Internal/);
    const empty = recorder(new Response(''));
    await assert.rejects(createYandexTts({ apiKey: 'x', voice: 'alexander', fetch: empty.doFetch }).synthesize('Привет'), /пустой/);
  });

  test('SpeechKit v3: длинный текст по частям, склейка без лишних ID3', async () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 3]), Buffer.from('tag'), Buffer.from('AUDIO')]);
    const texts: string[] = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      texts.push(JSON.parse(String(init.body)).text);
      return ndjson(id3);
    }) as typeof fetch;
    const long = 'Это предложение повторяется много раз. '.repeat(300);
    const audio = await createYandexTts({ apiKey: 'k', voice: 'alexander', fetch: doFetch }).synthesize(long);
    assert.ok(texts.length >= 3);
    assert.ok(texts.every((t) => t.length <= 4800 && t.endsWith('раз.')));
    assert.equal(texts.join(' '), long.trim());
    assert.equal(audio.toString('latin1'), id3.toString('latin1') + 'AUDIO'.repeat(texts.length - 1));
  });

  test('splitText и stripId3 на краях', () => {
    assert.deepEqual(splitText('Коротко.', 100), ['Коротко.']);
    const parts = splitText('слово '.repeat(50), 40);
    assert.ok(parts.every((p) => p.length <= 40));
    assert.equal(parts.join(' '), 'слово '.repeat(50).trim());
    assert.equal(stripId3(Buffer.from('noid3')).toString(), 'noid3');
  });

  test('выбор сервиса озвучки', () => {
    assert.equal(createTtsFromEnv({ YANDEX_API_KEY: 'k' })!.name, 'Yandex SpeechKit v3, голос alexander (good)');
    assert.match(createTtsFromEnv({ YANDEX_API_KEY: 'k', TTS_BASE_URL: 'http://localhost:8880/v1' })!.name, /SpeechKit/);
    assert.match(createTtsFromEnv({ YANDEX_API_KEY: 'k', TTS_BASE_URL: 'http://localhost:8880/v1', TTS_PROVIDER: 'openai' })!.name, /localhost:8880/);
    assert.equal(createTtsFromEnv({ YANDEX_API_KEY: 'k', YANDEX_TTS_VOICE: 'ermil' })!.name, 'Yandex SpeechKit v3, голос ermil');
    assert.equal(createTtsFromEnv({ YANDEX_API_KEY: 'k', YANDEX_TTS_ROLE: '' })!.name, 'Yandex SpeechKit v3, голос alexander');
    assert.throws(() => createTtsFromEnv({ TTS_PROVIDER: 'yandex' }), /YANDEX_API_KEY/);
    assert.throws(() => createTtsFromEnv({ TTS_PROVIDER: 'google' }), /допустимо/);
    assert.throws(() => createTtsFromEnv({ TTS_PROVIDER: 'openai' }), /TTS_BASE_URL/);
    assert.throws(() => createTtsFromEnv({ YANDEX_API_KEY: 'k', YANDEX_TTS_SPEED: '5' }), /0.1 до 3/);
    assert.throws(() => createTtsFromEnv({ YANDEX_API_KEY: 'k', YANDEX_TTS_PITCH: 'высоко' }), /-1000 до 1000/);
  });
});

describe('выбор ИИ', () => {
  const pick = (env: Record<string, string>) => createAiFromEnv(env).provider;

  test('без ключей ИИ выключен', () => {
    const setup = createAiFromEnv({ ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '' });
    assert.equal(setup.provider, null);
    assert.equal(setup.ai, null);
  });

  test('без AI_PROVIDER выбирается по ключу, Claude в приоритете', () => {
    assert.equal(pick({ DEEPSEEK_API_KEY: 'k' }), 'deepseek');
    assert.equal(pick({ ANTHROPIC_API_KEY: 'k' }), 'claude');
    assert.equal(pick({ ANTHROPIC_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' }), 'claude');
  });

  test('AI_PROVIDER важнее порядка ключей', () => {
    assert.equal(pick({ AI_PROVIDER: 'deepseek', ANTHROPIC_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' }), 'deepseek');
  });

  test('ошибка в настройке останавливает запуск', () => {
    assert.throws(() => pick({ AI_PROVIDER: 'gpt' }), /допустимые значения/);
    assert.throws(() => pick({ AI_PROVIDER: 'deepseek', ANTHROPIC_API_KEY: 'k' }), /DEEPSEEK_API_KEY/);
    assert.throws(() => pick({ AI_PROVIDER: 'claude', DEEPSEEK_API_KEY: 'k' }), /ANTHROPIC_API_KEY/);
  });

  test('модель по умолчанию и переопределение', () => {
    assert.equal(createAiFromEnv({ DEEPSEEK_API_KEY: 'k' }).model, 'deepseek-flash');
    assert.equal(createAiFromEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  });
});

describe('геометрия и бюджет', () => {
  test('длительность: остановки и ходьба укладываются в заявленное время', () => {
    const b = computeBudget({ durationMin: 60 }, true);
    assert.equal(b.maxStops, 5);
    assert.equal(b.walkMeters, 2700);
    assert.equal(b.maxMinutes, 60);
  });

  test('длина берётся как есть, радиус поиска ограничен', () => {
    const b = computeBudget({ distanceM: 30_000 }, false);
    assert.equal(b.walkMeters, 30_000);
    assert.equal(b.searchRadius, 5000);
    assert.equal(b.maxStops, 15);
  });

  test('порядок обхода не длиннее исходного', () => {
    const shuffled = [CANDIDATES[3]!, CANDIDATES[0]!, CANDIDATES[4]!, CANDIDATES[2]!, CANDIDATES[1]!];
    const ordered = orderStops(START, shuffled, true);
    assert.equal(ordered.length, shuffled.length);
    assert.ok(pathLength(START, ordered, true) <= pathLength(START, shuffled, true));
  });

  test('слияние источников: один объект не дублируется и получает статью', () => {
    const osm = [cand(1, 0, 0, { wikiTitle: undefined, name: 'Красная площадь', id: 'osm:1' })];
    const wiki = [
      cand(2, 0.00001, 0, { name: 'Красная площадь', id: 'wiki:1', wikiTitle: 'Красная площадь' }),
      cand(3, 0.01, 0, { name: 'Другое', id: 'wiki:2' }),
    ];
    const merged = mergeCandidates(osm, wiki);
    assert.deepEqual(merged.map((m) => m.id), ['osm:1', 'wiki:2']);
    assert.equal(merged[0]!.wikiTitle, 'Красная площадь');
  });
});

test('сравнение названий допускает уточнение, но не совпадение части', () => {
  assert.ok(sameTitle('Казанский собор', 'Казанский собор (Москва)'));
  assert.ok(sameTitle('ГУМ', 'гум'));
  assert.ok(!sameTitle('Фонтан', 'Фонтан Победителей'));
});

describe('планировщик', () => {
  const req = { start: START, budget: computeBudget({ durationMin: 60 }, true), roundTrip: true, lang: 'ru' };

  test('берёт выбор ИИ, отбрасывая дубли и выдуманные id', async () => {
    const plan = await planRoute(req, fakeGeo(), fakeAi());
    assert.equal(plan.planner, 'ai');
    assert.equal(plan.title, 'Тихий центр');
    assert.deepEqual(plan.stops.map((s) => s.id).sort(), ['c1', 'c3']);
    assert.deepEqual(plan.notices, []);
  });

  test('сбой ИИ не ломает генерацию и виден пользователю', async () => {
    const errors: unknown[] = [];
    const plan = await planRoute(
      req,
      fakeGeo(),
      fakeAi({ selectStops: async () => { throw new Error('boom'); } }),
      (e) => errors.push(e),
    );
    assert.equal(plan.planner, 'heuristic');
    assert.equal(errors.length, 1);
    assert.equal(plan.notices.length, 1);
    assert.ok(plan.stops.length > 0);
  });

  test('без ИИ эвристика не выходит за бюджет и не берёт далёкую точку', async () => {
    const plan = await planRoute(req, fakeGeo(), null);
    assert.equal(plan.planner, 'heuristic');
    assert.deepEqual(plan.notices, []);
    assert.ok(plan.stops.length <= req.budget.maxStops);
    assert.ok(!plan.stops.some((s) => s.id === 'c6'));
    assert.ok(plan.path.distanceM <= req.budget.walkMeters * 1.2);
  });

  test('если реальный путь длиннее бюджета, лишние точки снимаются', async () => {
    const ai = fakeAi({
      selectStops: async () => ({
        title: 'Т',
        description: 'О',
        stops: [{ candidateId: 'c1', teaser: '' }, { candidateId: 'c6', teaser: '' }],
      }),
    });
    const plan = await planRoute(req, fakeGeo(), ai);
    assert.deepEqual(plan.stops.map((s) => s.id), ['c1']);
  });

  test('эвристика не берёт статьи о событиях и компаниях, если есть настоящие места', () => {
    const list = [cand(1, 0.001, 0, { isPlace: false }), cand(2, 0.002, 0, { isPlace: true }), cand(3, 0.003, 0)];
    assert.deepEqual(selectHeuristic(req, list).map((c) => c.id).sort(), ['c2', 'c3']);
  });

  test('эвристика занимает заданное время, но не выходит за него', async () => {
    const dense = Array.from({ length: 20 }, (_, i) => cand(i, 0.001 * Math.cos(i), 0.0015 * Math.sin(i)));
    const plan = await planRoute(req, fakeGeo({ findCandidates: async () => dense }), null);
    assert.ok(plan.durationMin <= 60, `вышло ${plan.durationMin} мин`);
    assert.ok(plan.durationMin >= 40, `вышло только ${plan.durationMin} мин`);
  });

  test('известное место выше малоизвестного', () => {
    const list = [cand(1, 0.001, 0, { articleLength: 2000 }), cand(2, 0.002, 0, { articleLength: 150_000, hasImage: true })];
    assert.equal(rankCandidates(list, 1000)[0]!.id, 'c2');
  });

  test('эвристика всегда возвращает хотя бы одну точку', () => {
    const tiny = { ...req, budget: { walkMeters: 1, maxStops: 2, searchRadius: 400 } };
    assert.equal(selectHeuristic(tiny, CANDIDATES).length, 1);
  });
});

describe('API', () => {
  let app: FastifyInstance;
  let dir: string;
  let geo: GeoServices;
  let ai: AI | null;
  let n = 0;
  let uploadsDir: string;

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
      email: `u${++n}@example.com`,
      password: 'correct horse',
      name: `Пользователь ${n}`,
    });
    assert.equal(res.status, 201);
    return res.json.token as string;
  };

  const generate = async (token: string) => {
    const res = await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 });
    assert.equal(res.status, 201);
    return res.json.route;
  };

  const upload = (token: string, pointId: string, mime: string, content: Buffer) => {
    const boundary = 'testboundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\nContent-Type: ${mime}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api/points/${pointId}/media`,
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-'));
  });

  beforeEach(async () => {
    geo = fakeGeo();
    ai = fakeAi();
    const sub = mkdtempSync(path.join(dir, 't-'));
    uploadsDir = path.join(sub, 'uploads');
    app = await buildApp({
      db: openDb(path.join(sub, 'db.sqlite')),
      geo,
      ai,
      tts: { name: 'тест', synthesize: async () => Buffer.from('mp3') },
      uploadsDir,
    });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('регистрация, вход, неверный пароль, повторный email', async () => {
    const token = await register();
    assert.equal((await call('GET', '/api/me', token)).status, 200);
    assert.equal((await call('GET', '/api/me')).status, 401);

    const email = `u${n}@example.com`;
    assert.equal((await call('POST', '/api/auth/login', undefined, { email, password: 'wrong password' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', undefined, { email, password: 'correct horse' })).status, 200);
    assert.equal(
      (await call('POST', '/api/auth/register', undefined, { email, password: 'correct horse', name: 'x' })).status,
      409,
    );

    assert.equal((await call('POST', '/api/auth/logout', token)).status, 204);
    assert.equal((await call('GET', '/api/me', token)).status, 401);
  });

  test('генерация требует входа и либо длительности, либо длины', async () => {
    assert.equal((await call('POST', '/api/routes/generate', undefined, { start: START, durationMin: 60 })).status, 401);
    const token = await register();
    assert.equal((await call('POST', '/api/routes/generate', token, { start: START })).status, 400);
    assert.equal(
      (await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60, distanceM: 2000 })).status,
      400,
    );
    const route = await generate(token);
    assert.equal(route.planner, 'ai');
    assert.equal(route.isPublic, false);
    assert.equal(route.points.length, 2);
    assert.ok(route.geometry.length > 1);
    assert.equal(route.points[0].teaser.length > 0, true);
  });

  test('нет кандидатов — понятная ошибка; сбой источников — 502', async () => {
    const token = await register();
    geo.findCandidates = async () => [];
    assert.equal((await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 })).status, 422);
    geo.findCandidates = async () => { throw new Error('down'); };
    assert.equal((await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 })).status, 502);
  });

  test('приватный маршрут виден только автору, опубликованный — всем', async () => {
    const owner = await register();
    const other = await register();
    const route = await generate(owner);

    assert.equal((await call('GET', `/api/routes/${route.id}`)).status, 404);
    assert.equal((await call('GET', `/api/routes/${route.id}`, other)).status, 404);
    assert.equal((await call('GET', `/api/routes/${route.id}`, owner)).status, 200);
    assert.equal((await call('GET', '/api/routes')).json.routes.length, 0);

    assert.equal((await call('PATCH', `/api/routes/${route.id}`, other, { isPublic: true })).status, 404);
    assert.equal((await call('PATCH', `/api/routes/${route.id}`, owner, { isPublic: true })).status, 200);

    const pub = await call('GET', `/api/routes/${route.id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.route.isOwner, false);
    assert.equal((await call('GET', '/api/routes')).json.routes.length, 1);
    assert.equal((await call('PATCH', `/api/routes/${route.id}`, other, { title: 'Взлом' })).status, 403);
    assert.equal((await call('DELETE', `/api/routes/${route.id}`, other)).status, 403);
  });

  test('рейтинг: одна оценка на пользователя, свой маршрут оценить нельзя', async () => {
    const owner = await register();
    const a = await register();
    const b = await register();
    const route = await generate(owner);

    assert.equal((await call('PUT', `/api/routes/${route.id}/rating`, a, { value: 5 })).status, 404);
    await call('PATCH', `/api/routes/${route.id}`, owner, { isPublic: true });

    assert.equal((await call('PUT', `/api/routes/${route.id}/rating`, undefined, { value: 5 })).status, 401);
    assert.equal((await call('PUT', `/api/routes/${route.id}/rating`, owner, { value: 5 })).status, 403);
    assert.equal((await call('PUT', `/api/routes/${route.id}/rating`, a, { value: 6 })).status, 400);

    await call('PUT', `/api/routes/${route.id}/rating`, a, { value: 2 });
    await call('PUT', `/api/routes/${route.id}/rating`, a, { value: 3 });
    const res = await call('PUT', `/api/routes/${route.id}/rating`, b, { value: 5 });
    assert.deepEqual(res.json.route.rating, { avg: 4, count: 2 });
    assert.equal(res.json.route.myRating, 5);
  });

  test('каталог: сортировка по сглаженному рейтингу, поиск и фильтр по месту', async () => {
    const owner = await register();
    const voters = [await register(), await register(), await register(), await register()];
    const lone = await generate(owner);
    const solid = await generate(owner);
    await call('PATCH', `/api/routes/${lone.id}`, owner, { isPublic: true, title: 'Одна пятёрка' });
    await call('PATCH', `/api/routes/${solid.id}`, owner, { isPublic: true, title: 'Много 100% оценок' });
    await call('PUT', `/api/routes/${lone.id}/rating`, voters[0], { value: 5 });
    for (const v of voters) await call('PUT', `/api/routes/${solid.id}/rating`, v, { value: 5 });

    const top = await call('GET', '/api/routes?sort=rating');
    assert.equal(top.json.routes[0].id, solid.id);

    assert.equal((await call('GET', `/api/routes?q=${encodeURIComponent('пятёрка')}`)).json.routes.length, 1);
    // % в запросе — обычный символ, а не шаблон.
    assert.equal((await call('GET', `/api/routes?q=${encodeURIComponent('%')}`)).json.routes.length, 1);
    assert.equal((await call('GET', '/api/routes?lat=55.75&lng=37.62')).json.routes.length, 2);
    assert.equal((await call('GET', '/api/routes?lat=48.85&lng=2.35')).json.routes.length, 0);
    // Вид на карте берёт все старты одним запросом; страница списка — 20.
    assert.equal((await call('GET', '/api/routes?limit=1')).json.routes.length, 1);
    assert.equal((await call('GET', '/api/routes?limit=500')).status, 200);
    assert.equal((await call('GET', '/api/routes?limit=501')).status, 400);
  });

  test('рассказ: ИИ с источником и озвучка; правка текста сбрасывает озвучку', async () => {
    const token = await register();
    const route = await generate(token);
    const pid = route.points[0].id;

    const res = await call('POST', `/api/points/${pid}/story`, token, {});
    assert.equal(res.status, 200);
    const p = res.json.route.points[0];
    assert.ok(p.story.startsWith('Рассказ о месте'));
    assert.equal(p.storySource, 'ai_sourced');
    assert.ok(p.storySourceUrl);
    assert.match(p.narrationUrl, /^\/media\/.+\.mp3$/);
    assert.equal(p.media.length, 0);

    const audio = await app.inject({ method: 'GET', url: p.narrationUrl });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.headers['x-content-type-options'], 'nosniff');

    const edited = await call('PATCH', `/api/points/${pid}`, token, { story: 'Мой текст' });
    const e = edited.json.route.points[0];
    assert.equal(e.storySource, 'author');
    assert.equal(e.narrationUrl, null);
    assert.equal((await app.inject({ method: 'GET', url: p.narrationUrl })).statusCode, 404);

    const voiced = await call('POST', `/api/points/${pid}/story`, token, { keepText: true });
    assert.equal(voiced.json.route.points[0].story, 'Мой текст');
    assert.ok(voiced.json.route.points[0].narrationUrl);
  });

  test('рассказ: сбой ИИ откатывается на Википедию и помечается', async () => {
    const token = await register();
    const route = await generate(token);
    ai!.writeStory = async () => { throw new Error('boom'); };
    const res = await call('POST', `/api/points/${route.points[0].id}/story`, token, {});
    assert.equal(res.status, 200);
    const p = res.json.route.points[0];
    assert.equal(p.storySource, 'wikipedia');
    assert.equal(p.story, 'Статья 1 — известное место. Здесь много истории.');
    assert.equal(res.json.notices.length, 1);
  });

  test('рассказ: статья ищется рядом для точки без привязки, знаки ударения убираются', async () => {
    const token = await register();
    geo.findCandidates = async () => [cand(1, 0.002, 0, { wikiTitle: undefined, name: 'Мавзолей' })];
    const route = await generate(token);
    ai!.writeStory = async () => { throw new Error('boom'); };
    const seen: string[] = [];
    geo.findArticle = async (name) => `${name} (Москва)`;
    geo.wikiExtract = async (title) => {
      seen.push(title);
      return { text: 'Васи\u0301лий — имя.', url: 'https://ru.wikipedia.org/wiki/y' };
    };
    const res = await call('POST', `/api/points/${route.points[0].id}/story`, token, {});
    assert.deepEqual(seen, ['Мавзолей (Москва)']);
    assert.equal(res.json.route.points[0].story, 'Василий — имя.');
  });

  test('рассказ: сбой поиска статьи без ИИ даёт понятную ошибку', async () => {
    const token = await register();
    geo.findCandidates = async () => [cand(1, 0.002, 0, { wikiTitle: undefined })];
    const route = await generate(token);
    ai!.writeStory = async () => { throw new Error('boom'); };
    geo.findArticle = async () => { throw new Error('down'); };
    assert.equal((await call('POST', `/api/points/${route.points[0].id}/story`, token, {})).status, 502);
  });

  test('рассказ и удаление точки — только автор', async () => {
    const owner = await register();
    const other = await register();
    const route = await generate(owner);
    await call('PATCH', `/api/routes/${route.id}`, owner, { isPublic: true });
    const pid = route.points[0].id;
    assert.equal((await call('POST', `/api/points/${pid}/story`, other, {})).status, 403);
    assert.equal((await call('DELETE', `/api/points/${pid}`, other)).status, 403);
    assert.equal((await call('PATCH', `/api/points/${pid}`, other, { name: 'x' })).status, 403);
  });

  test('удаление точки пересчитывает маршрут; последнюю удалить нельзя', async () => {
    const token = await register();
    const route = await generate(token);
    const res = await call('DELETE', `/api/points/${route.points[0].id}`, token);
    assert.equal(res.status, 200);
    assert.equal(res.json.route.points.length, 1);
    assert.equal(res.json.route.points[0].position, 0);
    assert.ok(res.json.route.distanceM < route.distanceM);
    assert.equal((await call('DELETE', `/api/points/${res.json.route.points[0].id}`, token)).status, 409);
  });

  test('медиа: загрузка, доступ, отказ для опасных типов и чужих точек', async () => {
    const owner = await register();
    const other = await register();
    const route = await generate(owner);
    const pid = route.points[0].id;

    // Чужая приватная точка неотличима от несуществующей, опубликованная — запрещена.
    assert.equal((await upload(other, pid, 'image/png', Buffer.from('x'))).statusCode, 404);
    await call('PATCH', `/api/routes/${route.id}`, owner, { isPublic: true });
    assert.equal((await upload(other, pid, 'image/png', Buffer.from('x'))).statusCode, 403);
    assert.equal((await upload(owner, pid, 'image/svg+xml', Buffer.from('<svg/>'))).statusCode, 415);
    assert.equal((await upload(owner, pid, 'text/html', Buffer.from('<script>'))).statusCode, 415);

    const ok = await upload(owner, pid, 'image/png', Buffer.from('png-bytes'));
    assert.equal(ok.statusCode, 201);
    const m = JSON.parse(ok.body).route.points[0].media[0];
    assert.equal(m.kind, 'image');
    assert.equal(m.size, 9);
    assert.match(m.url, /^\/media\/[0-9a-f-]+\.png$/);

    const file = await app.inject({ method: 'GET', url: m.url });
    assert.equal(file.statusCode, 200);
    assert.equal(file.body, 'png-bytes');

    assert.equal((await call('DELETE', `/api/media/${m.id}`, other)).status, 403);
    assert.equal((await call('DELETE', `/api/media/${m.id}`, owner)).status, 200);
    assert.equal((await app.inject({ method: 'GET', url: m.url })).statusCode, 404);
  });

  test('слишком большое изображение отклоняется, файл не остаётся на диске', async () => {
    const token = await register();
    const route = await generate(token);
    const res = await upload(token, route.points[0].id, 'image/jpeg', Buffer.alloc(16 * 1024 * 1024));
    assert.equal(res.statusCode, 413);
    assert.deepEqual(readdirSync(uploadsDir), []);
  });

  test('удаление маршрута убирает его файлы', async () => {
    const token = await register();
    const route = await generate(token);
    const up = await upload(token, route.points[0].id, 'audio/mpeg', Buffer.from('mp3'));
    const url = JSON.parse(up.body).route.points[0].media[0].url;
    assert.equal((await call('DELETE', `/api/routes/${route.id}`, token)).status, 204);
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal((await call('GET', `/api/routes/${route.id}`, token)).status, 404);
  });

  test('страница карты и Leaflet отдаются с нужными заголовками', async () => {
    const page = await app.inject({ method: 'GET', url: '/map/index.html' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal((await app.inject({ method: 'GET', url: '/map/leaflet/leaflet.js' })).statusCode, 200);
  });
  // ---------- Правка маршрута ----------

  const names = (route: any) => route.points.map((p: any) => p.name);
  const ids = (route: any) => route.points.map((p: any) => p.id);

  test('добавить место: встаёт с наименьшим крюком, путь пересчитывается', async () => {
    const token = await register();
    const route = await generate(token);
    const before = route.points.length;
    // Между первыми двумя точками маршрута, рядом с линией.
    const [a, b] = route.points;
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const res = await call('POST', `/api/routes/${route.id}/points`, token, { name: 'Мой двор', ...mid, teaser: 'Тихо' });
    assert.equal(res.status, 201);
    const added = res.json.route.points.find((p: any) => p.id === res.json.pointId);
    assert.equal(added.name, 'Мой двор');
    assert.equal(added.kind, 'manual');
    assert.equal(added.position, 1, 'между первой и второй точкой');
    assert.equal(res.json.route.points.length, before + 1);
    assert.equal(res.json.route.geometry.length, before + 1 + 2, 'линия проходит через новую точку');
    assert.deepEqual(res.json.route.points.map((p: any) => p.position), [...Array(before + 1).keys()]);

    const atStart = await call('POST', `/api/routes/${route.id}/points`, token, { name: 'Первой', ...mid, position: 0 });
    assert.equal(atStart.json.route.points[0].name, 'Первой');
  });

  test('добавить место: только автор, не дальше 25 км, не больше 30 точек', async () => {
    const owner = await register();
    const other = await register();
    const route = await generate(owner);
    const near = { name: 'X', lat: START.lat + 0.001, lng: START.lng };
    assert.equal((await call('POST', `/api/routes/${route.id}/points`, undefined, near)).status, 401);
    assert.equal((await call('POST', `/api/routes/${route.id}/points`, other, near)).status, 404, 'чужой приватный маршрут не виден');
    assert.equal((await call('POST', `/api/routes/${route.id}/points`, owner, { ...near, lat: START.lat + 1 })).status, 422);
    assert.equal((await call('POST', `/api/routes/${route.id}/points`, owner, { ...near, name: '  ' })).status, 400);
    for (let i = route.points.length; i < 30; i++) {
      assert.equal((await call('POST', `/api/routes/${route.id}/points`, owner, near)).status, 201);
    }
    assert.equal((await call('POST', `/api/routes/${route.id}/points`, owner, near)).status, 409);
  });

  test('порядок точек: ручной, проверка перестановки, автоматический', async () => {
    const token = await register();
    const route = await generate(token);
    const reversed = [...ids(route)].reverse();
    const res = await call('PUT', `/api/routes/${route.id}/order`, token, { pointIds: reversed });
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.json.route), reversed);
    assert.deepEqual(names(res.json.route), [...names(route)].reverse());
    // Линия идёт от старта к новой первой точке.
    assert.deepEqual(res.json.route.geometry[1], [res.json.route.points[0].lat, res.json.route.points[0].lng]);
    // Перезагрузка сохраняет порядок.
    assert.deepEqual(ids((await call('GET', `/api/routes/${route.id}`, token)).json.route), reversed);

    const missing = reversed.slice(1);
    assert.equal((await call('PUT', `/api/routes/${route.id}/order`, token, { pointIds: missing })).status, 409);
    const dup = [reversed[0], ...reversed.slice(0, -1)];
    assert.equal((await call('PUT', `/api/routes/${route.id}/order`, token, { pointIds: dup })).status, 409);
    assert.equal((await call('PUT', `/api/routes/${route.id}/order`, token, { pointIds: [] })).status, 400);

    const auto = await call('PUT', `/api/routes/${route.id}/order`, token, { auto: true });
    assert.equal(auto.status, 200);
    assert.ok(auto.json.route.distanceM <= res.json.route.distanceM, 'автоматический порядок не длиннее обратного');

    const other = await register();
    assert.equal((await call('PUT', `/api/routes/${route.id}/order`, other, { auto: true })).status, 404);
  });

  test('места рядом: без уже добавленных и без не-мест', async () => {
    const token = await register();
    geo.findCandidates = async () => [...CANDIDATES, cand(7, 0.001, 0.001, { name: 'Парад', isPlace: false })];
    const route = await generate(token);
    const res = await call('GET', `/api/routes/${route.id}/suggestions`, token);
    assert.equal(res.status, 200);
    const suggested = res.json.suggestions.map((s: any) => s.name);
    for (const n of names(route)) assert.ok(!suggested.includes(n), `${n} уже в маршруте`);
    assert.ok(!suggested.includes('Парад'));
    assert.ok(suggested.length > 0);
    assert.equal(typeof res.json.suggestions[0].distanceM, 'number');

    geo.findCandidates = async () => {
      throw new Error('сеть');
    };
    assert.equal((await call('GET', `/api/routes/${route.id}/suggestions`, token)).status, 502);
    assert.equal((await call('GET', `/api/routes/${route.id}/suggestions`)).status, 401);
  });

  // ---------- Направление рассказа ----------

  test('направление рассказа: выбирается при создании, передаётся ИИ и в поиск источника', async () => {
    const token = await register();
    const seen: { style?: string; focus?: string }[] = [];
    ai!.writeStory = async ({ name, style }) => {
      seen.push({ style });
      return `${style === 'legends' ? 'Легенда' : 'Факт'} о ${name}`;
    };
    geo.wikiExtract = async (title, _lang, focus) => {
      seen.push({ focus });
      return { text: `${title}. Текст`, url: 'https://ru.wikipedia.org/wiki/x' };
    };
    const res = await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60, storyStyle: 'legends' });
    assert.equal(res.json.route.storyStyle, 'legends');
    const pointId = res.json.route.points[0].id;

    const legend = await call('POST', `/api/points/${pointId}/story`, token, {});
    assert.match(legend.json.route.points[0].story, /^Легенда/);
    assert.equal(legend.json.route.points[0].storyStyle, 'legends');
    assert.deepEqual(seen.slice(-2), [{ focus: 'legends' }, { style: 'legends' }], 'источник и ИИ получают направление');

    // Явный стиль в запросе важнее стиля маршрута.
    const fact = await call('POST', `/api/points/${pointId}/story`, token, { style: 'facts' });
    assert.match(fact.json.route.points[0].story, /^Факт/);
    assert.equal(fact.json.route.points[0].storyStyle, 'facts');

    // Стиль маршрута меняется.
    const patched = await call('PATCH', `/api/routes/${res.json.route.id}`, token, { storyStyle: 'facts' });
    assert.equal(patched.json.route.storyStyle, 'facts');
    assert.equal((await call('PATCH', `/api/routes/${res.json.route.id}`, token, { storyStyle: 'сказки' })).status, 400);

    // Текст автора — без направления.
    const own = await call('PATCH', `/api/points/${pointId}`, token, { story: 'Мой текст' });
    assert.equal(own.json.route.points[0].storyStyle, null);

    // По умолчанию — факты.
    assert.equal((await generate(token)).storyStyle, 'facts');
  });

  test('легенды без ИИ: раздел статьи о легендах, а если его нет — обычный текст с пояснением', async () => {
    const token = await register();
    ai!.writeStory = async () => {
      throw new Error('ИИ недоступен');
    };
    geo.wikiExtract = async (_t, _l, focus) => ({
      text: focus === 'legends' ? ARTICLE : 'Только факты.',
      url: 'https://ru.wikipedia.org/wiki/x',
    });
    const route = (await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60, storyStyle: 'legends' })).json.route;
    const res = await call('POST', `/api/points/${route.points[0].id}/story`, token, {});
    const p = res.json.route.points[0];
    assert.match(p.story, /библиотека/);
    assert.match(p.story, /огонёк/);
    assert.doesNotMatch(p.story, /==/, 'без заголовков разделов');
    assert.equal(p.storyStyle, 'legends');
    assert.equal(p.storySource, 'wikipedia');

    geo.wikiExtract = async () => ({ text: 'Здание.\n== История ==\nПостроено давно.', url: 'https://ru.wikipedia.org/wiki/y' });
    const none = await call('POST', `/api/points/${route.points[1].id}/story`, token, {});
    assert.equal(none.json.route.points[1].storyStyle, 'facts', 'честно помечено как факты');
    assert.ok(none.json.notices.some((n: string) => /Легенд об этом месте/.test(n)));
  });

  // ---------- Старт и финиш ----------

  test('старт и финиш: перенос старта, свой финиш, финиш на последней точке и у старта', async () => {
    const token = await register();
    const route = await generate(token); // кольцевой по умолчанию
    assert.equal(route.roundTrip, true);
    assert.equal(route.finish, null);
    const ep = (body: unknown) => call('PATCH', `/api/routes/${route.id}/endpoints`, token, body);

    const newStart = { lat: START.lat + 0.004, lng: START.lng + 0.004, label: 'Новый старт' };
    const moved = await ep({ start: newStart });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.json.route.start, newStart);
    assert.deepEqual(moved.json.route.geometry[0], [newStart.lat, newStart.lng], 'путь начинается с нового старта');
    assert.deepEqual(moved.json.route.geometry.at(-1), [newStart.lat, newStart.lng], 'кольцо возвращается к новому старту');

    const finish = { type: 'point', lat: START.lat - 0.004, lng: START.lng, label: 'Метро' };
    const custom = await ep({ finish });
    assert.equal(custom.json.route.roundTrip, false);
    assert.deepEqual(custom.json.route.finish, { lat: finish.lat, lng: finish.lng, label: 'Метро' });
    assert.deepEqual(custom.json.route.geometry.at(-1), [finish.lat, finish.lng], 'путь кончается на финише');
    assert.equal(custom.json.route.geometry.length, route.points.length + 2);

    // Свой финиш учитывается при добавлении и автопорядке, попадает в GPX.
    const auto = await call('PUT', `/api/routes/${route.id}/order`, token, { auto: true });
    assert.deepEqual(auto.json.route.geometry.at(-1), [finish.lat, finish.lng]);
    const gpx = await app.inject({ method: 'GET', url: `/api/routes/${route.id}/export?format=gpx`, headers: { authorization: `Bearer ${token}` } });
    assert.match(gpx.body, /<name>Финиш: Метро<\/name>/);

    const last = await ep({ finish: { type: 'last' } });
    assert.equal(last.json.route.finish, null);
    assert.equal(last.json.route.roundTrip, false);
    const lastPoint = last.json.route.points.at(-1);
    assert.deepEqual(last.json.route.geometry.at(-1), [lastPoint.lat, lastPoint.lng], 'кончается на последней точке');

    const ring = await ep({ finish: { type: 'start' } });
    assert.equal(ring.json.route.roundTrip, true);
    assert.deepEqual(ring.json.route.geometry.at(-1), [newStart.lat, newStart.lng]);

    // Перезагрузка сохраняет.
    const reloaded = (await call('GET', `/api/routes/${route.id}`, token)).json.route;
    assert.deepEqual(reloaded.start, newStart);
    assert.equal(reloaded.roundTrip, true);
  });

  test('старт и финиш: проверки', async () => {
    const owner = await register();
    const other = await register();
    const route = await generate(owner);
    const url = `/api/routes/${route.id}/endpoints`;
    assert.equal((await call('PATCH', url, owner, {})).status, 400);
    assert.equal((await call('PATCH', url, owner, { start: { lat: START.lat + 1, lng: START.lng } })).status, 422, 'слишком далеко');
    assert.equal((await call('PATCH', url, owner, { finish: { type: 'point', lat: START.lat, lng: START.lng + 1 } })).status, 422);
    assert.equal((await call('PATCH', url, owner, { finish: { type: 'где-то' } })).status, 400);
    assert.equal((await call('PATCH', url, other, { finish: { type: 'last' } })).status, 404);
    assert.equal((await call('PATCH', url, undefined, { finish: { type: 'last' } })).status, 401);
  });

  test('перенос старта обновляет город', async () => {
    const token = await register();
    const route = await generate(token);
    await call('PATCH', `/api/routes/${route.id}`, token, { isPublic: true });
    geo.reverseCity = async () => 'Химки';
    await call('PATCH', `/api/routes/${route.id}/endpoints`, token, { start: { lat: START.lat + 0.01, lng: START.lng } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call('GET', `/api/routes/${route.id}`, token)).json.route.city, 'Химки');
  });

  // ---------- Экспорт ----------

  test('экспорт GPX и KML: точки по порядку, доступ как у маршрута', async () => {
    const owner = await register();
    const route = await generate(owner);
    await call('PATCH', `/api/points/${route.points[0].id}`, owner, { name: 'Дом <Пашкова> & сад' });
    const get = (format: string, token?: string) =>
      app.inject({ method: 'GET', url: `/api/routes/${route.id}/export?format=${format}`, headers: token ? { authorization: `Bearer ${token}` } : {} });

    const gpx = await get('gpx', owner);
    assert.equal(gpx.statusCode, 200);
    assert.match(String(gpx.headers['content-type']), /application\/gpx\+xml/);
    assert.match(String(gpx.headers['content-disposition']), /^attachment; filename=".*\.gpx"; filename\*=UTF-8''/);
    const cross = await app.inject({
      method: 'GET',
      url: `/api/routes/${route.id}/export?format=gpx`,
      headers: { authorization: `Bearer ${owner}`, origin: 'http://localhost:8081' },
    });
    assert.match(String(cross.headers['access-control-expose-headers']), /Content-Disposition/, 'имя файла видно приложению на другом порту');
    assert.match(gpx.body, /<name>1\. Дом &lt;Пашкова&gt; &amp; сад<\/name>/);
    assert.equal((gpx.body.match(/<wpt /g) ?? []).length, route.points.length + 1, 'точки и старт');
    assert.equal((gpx.body.match(/<trkpt /g) ?? []).length, route.geometry.length);

    const kml = await get('kml', owner);
    assert.equal(kml.statusCode, 200);
    assert.match(String(kml.headers['content-type']), /kml/);
    assert.match(kml.body, /<LineString>/);

    assert.equal((await get('gpx')).statusCode, 404, 'приватный маршрут не скачать без входа');
    assert.equal((await get('pdf', owner)).statusCode, 400);
    await call('PATCH', `/api/routes/${route.id}`, owner, { isPublic: true });
    assert.equal((await get('gpx')).statusCode, 200, 'открытый маршрут скачивается без входа');
  });

  // ---------- Города ----------

  test('города: маршрут получает город, каталог фильтруется, список с количеством', async () => {
    const token = await register();
    const moscow = await generate(token);
    geo.reverseCity = async () => 'Казань';
    const kazan = await generate(token);
    geo.reverseCity = async () => {
      throw new Error('Nominatim недоступен');
    };
    const unknown = await generate(token);
    assert.equal(moscow.city, 'Москва');
    assert.equal(kazan.city, 'Казань');
    assert.equal(unknown.city, null, 'маршрут создаётся и без города');
    for (const r of [moscow, kazan, unknown]) await call('PATCH', `/api/routes/${r.id}`, token, { isPublic: true });

    const inKazan = await call('GET', `/api/routes?city=${encodeURIComponent('Казань')}`);
    assert.deepEqual(inKazan.json.routes.map((r: any) => r.id), [kazan.id]);
    assert.equal((await call('GET', '/api/routes')).json.routes.length, 3, 'без фильтра — все');

    const cities = await call('GET', '/api/cities');
    assert.deepEqual(cities.json.cities.map((c: any) => [c.name, c.count]).sort(), [['Казань', 1], ['Москва', 1]]);

    const found = await call('GET', `/api/cities/search?q=${encodeURIComponent('Тверь')}`);
    assert.equal(found.json.cities[0].name, 'Тверь');
    assert.equal((await call('GET', '/api/cities/search?q=x')).status, 400);

    geo.reverseCity = async () => 'Тула';
    const located = await call('GET', `/api/cities/locate?lat=54.19&lng=37.61`);
    assert.equal(located.json.city.name, 'Тула');
    geo.reverseCity = async () => null;
    assert.equal((await call('GET', `/api/cities/locate?lat=0&lng=0`)).status, 404);
  });

  test('за прокси лимиты считаются по настоящему IP клиента', async () => {
    const proxied = await buildApp({ db: openDb(path.join(mkdtempSync(path.join(dir, 'p-')), 'db.sqlite')), geo, ai, tts: null, uploadsDir, trustProxy: true });
    const hit = (ip: string) =>
      proxied.inject({ method: 'GET', url: '/api/cities/locate?lat=1&lng=1', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 30; i++) assert.notEqual((await hit('1.1.1.1')).statusCode, 429);
    assert.equal((await hit('1.1.1.1')).statusCode, 429, 'первый клиент упёрся в лимит');
    assert.notEqual((await hit('2.2.2.2')).statusCode, 429, 'второй клиент не страдает');
  });

  test('поиск адреса передаёт выбранный город', async () => {
    let near: unknown;
    geo.geocode = async (q, _lang, n) => {
      near = n;
      return [{ name: q, ...START }];
    };
    await call('GET', `/api/geocode?q=${encodeURIComponent('Арбат')}&lat=55.75&lng=37.6`);
    assert.deepEqual(near, { lat: 55.75, lng: 37.6 });
    await call('GET', `/api/geocode?q=${encodeURIComponent('Арбат')}`);
    assert.equal(near, undefined);
  });
});
