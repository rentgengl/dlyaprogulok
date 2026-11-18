import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

process.env.NODE_ENV = 'test';

import type { AI } from '../src/ai.ts';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import type { Mail } from '../src/mail.ts';
import type { GeoServices } from '../src/services.ts';
import { maskSecret, paymentsFromEnv, pricingFromEnv, servicesFromEnv, type Env, type Services } from '../src/settings.ts';

const START = { lat: 55.75, lng: 37.62 };

const geo: GeoServices = {
  findCandidates: async () => [
    { id: 'c1', name: 'Храм', kind: 'attraction', wikiTitle: 'Храм', distanceFromStart: 200, lat: 55.752, lng: 37.62 },
    { id: 'c2', name: 'Башня', kind: 'attraction', wikiTitle: 'Башня', distanceFromStart: 300, lat: 55.75, lng: 37.624 },
  ],
  walkPath: async (start, stops) => ({ distanceM: 1000, geometry: [start, ...stops].map((p) => [p.lat, p.lng]), routed: true }),
  geocode: async () => [],
  reverseCity: async () => 'Москва',
  searchCities: async () => [],
  wikiExtract: async (title) => ({ text: `${title} — известное место.`, url: 'https://ru.wikipedia.org/wiki/x' }),
  findArticle: async () => null,
  placePhotos: async (items) => items.map(() => ({ wikidata: null, photo: null })),
  placeFacts: async () => null,
  otherArticle: async () => null,
};

const fakeAi = (): AI => ({
  selectStops: async () => ({ title: 'Прогулка', description: 'Описание', stops: [{ candidateId: 'c1', teaser: 'Первая' }] }),
  writeStory: async ({ name }) => `Рассказ о ${name}`,
});

describe('админка', () => {
  let app: FastifyInstance;
  let dir: string;
  let n = 0;
  let mails: Mail[];
  /** Окружения, с которыми админка пересобирала сервисы. */
  let rebuilt: Env[];

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };

  const register = async (email = `u${++n}@example.com`) => {
    const res = await call('POST', '/api/auth/register', undefined, { email, password: 'correct horse', name: `Пользователь ${n}` });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return { token: res.json.token as string, user: res.json.user };
  };

  const generate = async (token: string) => {
    const res = await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.route;
  };

  const start = async (baseEnv: Env = {}) => {
    const sub = mkdtempSync(path.join(dir, 't-'));
    app = await buildApp({
      db: openDb(path.join(sub, 'db.sqlite')),
      geo,
      ai: fakeAi(),
      tts: null,
      uploadsDir: path.join(sub, 'uploads'),
      routeMonthlyLimit: 2,
      adminEmails: ['Boss@Example.com'],
      baseEnv,
      reconfigure: (env) => {
        rebuilt.push(env);
        // Настоящая сборка — ради проверки ошибок; ИИ и почта — подставные.
        const real = servicesFromEnv({ ...env, ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '' });
        const s: Services = {
          ...real,
          ai: fakeAi(),
          mailer: env.SMTP_URL ? { name: 'тестовый SMTP', send: async (m) => void mails.push(m) } : null,
        };
        return s;
      },
    });
  };

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-admin-'));
  });
  beforeEach(async () => {
    mails = [];
    rebuilt = [];
    await start({ DEEPSEEK_API_KEY: 'sk-from-env-1234', ROUTE_MONTHLY_LIMIT: '2', PORT: '3000' });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('доступ: только администратор; адрес из ADMIN_EMAILS получает права при регистрации', async () => {
    const guest = await call('GET', '/api/admin/stats');
    assert.equal(guest.status, 401);
    const user = await register();
    assert.equal(user.user.isAdmin, false);
    assert.equal((await call('GET', '/api/admin/users', user.token)).status, 403);
    assert.equal((await call('PUT', '/api/admin/settings', user.token, { values: { ROUTE_MONTHLY_LIMIT: '0' } })).status, 403);

    const boss = await register('boss@example.com');
    assert.equal(boss.user.isAdmin, true);
    const stats = await call('GET', '/api/admin/stats', boss.token);
    assert.equal(stats.status, 200);
    assert.equal(stats.json.users.total, 2);
    assert.equal(stats.json.users.admins, 1);
  });

  test('пользователи: список, поиск, свой лимит, сброс счётчика, права, пароль', async () => {
    const boss = await register('boss@example.com');
    const u = await register();
    await generate(u.token);
    await generate(u.token);
    assert.equal((await call('POST', '/api/routes/generate', u.token, { start: START, durationMin: 60 })).status, 429);

    const list = await call('GET', `/api/admin/users?q=${encodeURIComponent(u.user.email)}`, boss.token);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.users[0].routeCount, 2);
    assert.equal(list.json.users[0].usedThisMonth, 2);

    // Свой лимит: 5 вместо общего 2.
    const raised = await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { routeLimit: 5 });
    assert.equal(raised.json.user.routeLimit, 5);
    assert.equal(raised.json.user.quota.remaining, 3);
    assert.equal((await call('GET', '/api/me', u.token)).json.user.quota.limit, 5);
    await generate(u.token);

    // 0 — без ограничения; null — снова общий лимит.
    assert.equal((await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { routeLimit: 0 })).json.user.quota.limit, null);
    const back = await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { routeLimit: null });
    assert.equal(back.json.user.quota.limit, 2);
    assert.equal(back.json.user.quota.remaining, 0);
    const reset = await call('POST', `/api/admin/users/${u.user.id}/quota-reset`, boss.token);
    assert.equal(reset.json.user.quota.remaining, 2);

    // Имя, почта, подтверждение, права.
    const edited = await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, {
      name: 'Новое имя',
      email: 'NEW@example.com',
      emailVerified: false,
      isAdmin: true,
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(
      [edited.json.user.name, edited.json.user.email, edited.json.user.emailVerified, edited.json.user.isAdmin],
      ['Новое имя', 'new@example.com', false, true],
    );
    assert.equal((await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { email: 'boss@example.com' })).status, 409);

    // Новый пароль: старые сессии закрыты, вход с новым паролем.
    assert.equal((await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { password: 'brand new pass' })).status, 200);
    assert.equal((await call('GET', '/api/me', u.token)).status, 401);
    const login = await call('POST', '/api/auth/login', undefined, { email: 'new@example.com', password: 'brand new pass' });
    assert.equal(login.status, 200);
  });

  test('блокировка: сессии закрыты, вход запрещён; себя заблокировать нельзя', async () => {
    const boss = await register('boss@example.com');
    const u = await register();
    assert.equal((await call('PATCH', `/api/admin/users/${boss.user.id}`, boss.token, { blocked: true })).status, 409);
    assert.equal((await call('PATCH', `/api/admin/users/${boss.user.id}`, boss.token, { isAdmin: false })).status, 409);

    const blocked = await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { blocked: true });
    assert.equal(blocked.json.user.blocked, true);
    assert.equal((await call('GET', '/api/me', u.token)).status, 401);
    const login = await call('POST', '/api/auth/login', undefined, { email: u.user.email, password: 'correct horse' });
    assert.equal(login.status, 403);
    assert.match(login.json.error, /заблокирован/);

    await call('PATCH', `/api/admin/users/${u.user.id}`, boss.token, { blocked: false });
    assert.equal((await call('POST', '/api/auth/login', undefined, { email: u.user.email, password: 'correct horse' })).status, 200);
  });

  test('удаление пользователя вместе с маршрутами', async () => {
    const boss = await register('boss@example.com');
    const u = await register();
    const route = await generate(u.token);
    assert.equal((await call('DELETE', `/api/admin/users/${boss.user.id}`, boss.token)).status, 409);
    const lastAdmin = await call('DELETE', '/api/me', boss.token, { password: 'correct horse' });
    assert.equal(lastAdmin.status, 409, 'единственный администратор не удаляет себя');
    assert.equal((await call('DELETE', `/api/admin/users/${u.user.id}`, boss.token)).status, 204);
    assert.equal((await call('GET', `/api/admin/users/${u.user.id}`, boss.token)).status, 404);
    assert.equal((await call('GET', `/api/routes/${route.id}`, boss.token)).status, 404);
  });

  test('маршруты: все, включая приватные; правка, передача, удаление и редактор', async () => {
    const boss = await register('boss@example.com');
    const a = await register();
    const b = await register();
    const route = await generate(a.token);
    assert.equal(route.isPublic, false);

    const list = await call('GET', '/api/admin/routes?visibility=private', boss.token);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.routes[0].ownerEmail, a.user.email);
    assert.equal((await call('GET', `/api/admin/routes?q=${encodeURIComponent(a.user.email)}`, boss.token)).json.total, 1);

    // Чужой приватный маршрут администратор видит и может править обычным API.
    const full = await call('GET', `/api/routes/${route.id}`, boss.token);
    assert.equal(full.status, 200);
    assert.equal(full.json.route.canEdit, true);
    assert.equal(full.json.route.isOwner, false);
    assert.equal((await call('GET', `/api/routes/${route.id}`, b.token)).status, 404);
    const pointId = full.json.route.points[0].id;
    assert.equal((await call('PATCH', `/api/points/${pointId}`, boss.token, { name: 'Исправлено' })).status, 200);
    assert.equal((await call('PATCH', `/api/points/${pointId}`, b.token, { name: 'Взлом' })).status, 404);

    const patched = await call('PATCH', `/api/admin/routes/${route.id}`, boss.token, {
      title: 'Новое название',
      isPublic: true,
      owner: b.user.email,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.route.title, 'Новое название');
    assert.equal(patched.json.route.isPublic, true);
    assert.equal(patched.json.route.ownerEmail, b.user.email);
    assert.equal((await call('GET', '/api/routes/mine', b.token)).json.routes.length, 1);
    assert.equal((await call('PATCH', `/api/admin/routes/${route.id}`, boss.token, { owner: 'nobody@example.com' })).status, 404);

    assert.equal((await call('DELETE', `/api/routes/${route.id}`, boss.token)).status, 204);
    assert.equal((await call('GET', '/api/admin/routes', boss.token)).json.total, 0);
  });

  test('настройки: секреты скрыты, правка применяется сразу, ошибка не сохраняется, сброс к .env', async () => {
    const boss = await register('boss@example.com');
    const view = await call('GET', '/api/admin/settings', boss.token);
    const byKey = (list: any[], key: string) => list.find((s) => s.key === key);
    const key = byKey(view.json.settings, 'DEEPSEEK_API_KEY');
    assert.equal(key.value, null, 'секрет не отдаётся');
    assert.equal(key.masked, '••••1234');
    assert.equal(key.source, 'env');
    assert.equal(byKey(view.json.settings, 'PORT').editable, false);
    assert.ok(!JSON.stringify(view.json).includes('sk-from-env'));

    // Общий лимит меняется на лету.
    const u = await register();
    const saved = await call('PUT', '/api/admin/settings', boss.token, { values: { ROUTE_MONTHLY_LIMIT: '7' } });
    assert.equal(saved.status, 200);
    assert.equal(byKey(saved.json.settings, 'ROUTE_MONTHLY_LIMIT').source, 'admin');
    assert.equal(byKey(saved.json.settings, 'ROUTE_MONTHLY_LIMIT').updatedBy, 'boss@example.com');
    assert.equal((await call('GET', '/api/me', u.token)).json.user.quota.limit, 7);
    assert.equal((await call('GET', '/api/config')).json.routeMonthlyLimit, 7);
    assert.equal(rebuilt.at(-1)!.DEEPSEEK_API_KEY, 'sk-from-env-1234', 'остальное — из .env');

    // Неверное значение: ошибка, прежние настройки на месте.
    const bad = await call('PUT', '/api/admin/settings', boss.token, { values: { ROUTE_MONTHLY_LIMIT: 'много' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /ROUTE_MONTHLY_LIMIT/);
    assert.equal((await call('GET', '/api/config')).json.routeMonthlyLimit, 7);
    assert.equal((await call('PUT', '/api/admin/settings', boss.token, { values: { PORT: '80' } })).status, 400);

    // Почта: включается из админки, пробное письмо уходит администратору.
    assert.equal((await call('POST', '/api/admin/settings/test-mail', boss.token)).status, 409);
    const mail = await call('PUT', '/api/admin/settings', boss.token, {
      values: { SMTP_URL: 'smtps://info%40x.ru:secret-pass@mail.x.ru:465', MAIL_FROM: 'Для прогулок <info@x.ru>' },
    });
    assert.equal(mail.status, 200);
    assert.equal(byKey(mail.json.settings, 'SMTP_URL').masked, 'smtps://info%40x.ru:••••@mail.x.ru:465');
    assert.ok(!JSON.stringify(mail.json).includes('secret-pass'));
    assert.equal((await call('GET', '/api/config')).json.emailVerification, true);
    const sent = await call('POST', '/api/admin/settings/test-mail', boss.token);
    assert.equal(sent.json.sentTo, 'boss@example.com');
    assert.equal(mails[0]!.to, 'boss@example.com');

    // null — вернуть как в .env.
    const reverted = await call('PUT', '/api/admin/settings', boss.token, { values: { ROUTE_MONTHLY_LIMIT: null, SMTP_URL: null } });
    assert.equal(byKey(reverted.json.settings, 'ROUTE_MONTHLY_LIMIT').source, 'env');
    assert.equal((await call('GET', '/api/config')).json.routeMonthlyLimit, 2);
    assert.equal((await call('GET', '/api/config')).json.emailVerification, false);
  });

  test('ручной маршрут: пустой, без лимита и ИИ; места добавляются вручную', async () => {
    const u = await register();
    // Лимит автоподбора исчерпан — ручной маршрут всё равно создаётся.
    await generate(u.token);
    await generate(u.token);
    assert.equal((await call('GET', '/api/me', u.token)).json.user.quota.remaining, 0);

    assert.equal((await call('POST', '/api/routes', u.token, { title: '', start: START })).status, 400);
    const res = await call('POST', '/api/routes', u.token, {
      title: 'Мои дворы',
      description: 'Только любимое',
      start: { ...START, label: 'Арбат' },
      roundTrip: false,
      storyStyle: 'legends',
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const route = res.json.route;
    assert.deepEqual(
      [route.title, route.description, route.planner, route.points.length, route.distanceM, route.roundTrip, route.storyStyle, route.city],
      ['Мои дворы', 'Только любимое', 'manual', 0, 0, false, 'legends', 'Москва'],
    );
    assert.equal((await call('GET', '/api/me', u.token)).json.user.quota.used, 2, 'лимит не тратится');

    // Пустой маршрут нельзя открыть в каталоге.
    const early = await call('PATCH', `/api/routes/${route.id}`, u.token, { isPublic: true });
    assert.equal(early.status, 409);

    // Места рядом и добавление первой точки.
    assert.equal((await call('GET', `/api/routes/${route.id}/suggestions`, u.token)).json.suggestions.length, 2);
    const added = await call('POST', `/api/routes/${route.id}/points`, u.token, { name: 'Мой двор', lat: 55.751, lng: 37.621 });
    assert.equal(added.status, 201);
    assert.equal(added.json.route.points.length, 1);
    assert.ok(added.json.route.distanceM > 0);
    const pid = added.json.pointId;
    const story = await call('PATCH', `/api/points/${pid}`, u.token, { story: 'Здесь я вырос.', teaser: 'Двор детства' });
    assert.equal(story.json.route.points[0].storySource, 'author');
    assert.equal((await call('PATCH', `/api/routes/${route.id}`, u.token, { isPublic: true })).status, 200);
    assert.equal((await call('DELETE', `/api/points/${pid}`, u.token)).status, 409, 'последняя точка остаётся');
  });

  test('ручной маршрут: только с подтверждённой почтой и для вошедших', async () => {
    assert.equal((await call('POST', '/api/routes', undefined, { title: 'X', start: START })).status, 401);
  });

  const idle = () => (app as any).jobs.idle() as Promise<void>;

  test('фон: маршрут подбирается в задаче, рассказы создаются сервером, лимит учитывает задачу', async () => {
    const u = await register();
    const res = await call('POST', '/api/routes/generate', u.token, { start: START, durationMin: 60, background: true, autoStories: true });
    assert.equal(res.status, 202, JSON.stringify(res.json));
    assert.equal(res.json.quota.used, 1, 'задача сразу занимает место в лимите');
    const jobId = res.json.job.id;
    await idle();
    const job = (await call('GET', `/api/jobs/${jobId}`, u.token)).json.job;
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.ok(job.routeId);
    assert.equal(job.total, 1);
    assert.equal(job.done, 1);
    const route = (await call('GET', `/api/routes/${job.routeId}`, u.token)).json.route;
    assert.ok(route.points.every((p: any) => p.story));
    assert.equal(route.job.id, jobId, 'итог задачи виден в маршруте');
    assert.equal((await call('GET', '/api/me', u.token)).json.user.quota.used, 1, 'после готовности считается один раз');
    assert.equal((await call('GET', '/api/jobs', u.token)).json.jobs.length, 1);

    // Чужую задачу не видно.
    const other = await register();
    assert.equal((await call('GET', `/api/jobs/${jobId}`, other.token)).status, 404);
  });

  test('фон: исчерпанный лимит и ошибка подбора', async () => {
    const u = await register();
    await call('POST', '/api/routes/generate', u.token, { start: START, durationMin: 60, background: true });
    await call('POST', '/api/routes/generate', u.token, { start: START, durationMin: 60, background: true });
    const third = await call('POST', '/api/routes/generate', u.token, { start: START, durationMin: 60, background: true });
    assert.equal(third.status, 429, 'две задачи в очереди уже исчерпали лимит 2');
    await idle();

    const lone = await register();
    const saved = geo.findCandidates;
    geo.findCandidates = async () => [];
    try {
      const res = await call('POST', '/api/routes/generate', lone.token, { start: START, durationMin: 60, background: true });
      await idle();
      const job = (await call('GET', `/api/jobs/${res.json.job.id}`, lone.token)).json.job;
      assert.equal(job.status, 'failed');
      assert.match(job.error, /не нашлось достопримечательностей/);
      assert.equal((await call('GET', '/api/me', lone.token)).json.user.quota.used, 0, 'неудача лимит не тратит');
    } finally {
      geo.findCandidates = saved;
    }
  });

  test('фон: рассказы для существующего маршрута; повторный запрос возвращает ту же задачу', async () => {
    const u = await register();
    const route = await generate(u.token);
    // Источник отвечает, только когда тест разрешит: задача ещё идёт во время второго запроса.
    const saved = geo.wikiExtract;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    geo.wikiExtract = async (...args) => {
      await gate;
      return saved(...args);
    };
    try {
      const first = await call('POST', `/api/routes/${route.id}/stories`, u.token, {});
      const again = await call('POST', `/api/routes/${route.id}/stories`, u.token, {});
      assert.equal(first.status, 202);
      assert.equal(again.json.job.id, first.json.job.id);
      const during = (await call('GET', `/api/routes/${route.id}`, u.token)).json.route;
      assert.equal(during.job.status, 'running');
      release();
      await idle();
    } finally {
      geo.wikiExtract = saved;
    }
    const after = (await call('GET', `/api/routes/${route.id}`, u.token)).json.route;
    assert.ok(after.points.every((p: any) => p.story));
    assert.equal(after.job.status, 'done');
    // Направление «легенды»: redo переписывает рассказы другого направления.
    const redo = await call('POST', `/api/routes/${route.id}/stories`, u.token, { style: 'legends', redo: true });
    await idle();
    const job = (await call('GET', `/api/jobs/${redo.json.job.id}`, u.token)).json.job;
    assert.equal(job.total, after.points.length);
    const legends = (await call('GET', `/api/routes/${route.id}`, u.token)).json.route;
    assert.ok(legends.points.every((p: any) => p.storyStyle === 'legends'));
  });

  test('маска секретов', () => {
    assert.equal(maskSecret(undefined), null);
    assert.equal(maskSecret('short'), '••••');
    assert.equal(maskSecret('AQVN-very-long-key-9f3a'), '••••9f3a');
    assert.equal(maskSecret('smtps://u%40d.ru:p@ss@mail.d.ru:465'), 'smtps://u%40d.ru:••••@mail.d.ru:465');
  });
});

describe('админка: деньги (US5)', () => {
  let app: FastifyInstance;
  let dir: string;
  let db: import('node:sqlite').DatabaseSync;
  let n = 0;
  const env: Env = { PAYMENTS_PROVIDER: 'fake' };

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-admin-money-'));
  });
  after(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await app?.close();
    const sub = mkdtempSync(path.join(dir, 't-'));
    db = openDb(path.join(sub, 'db.sqlite'));
    app = await buildApp({
      db,
      geo,
      ai: null,
      tts: null,
      uploadsDir: path.join(sub, 'uploads'),
      adminEmails: ['boss@example.com'],
      baseEnv: env,
      reconfigure: (e) => servicesFromEnv({ ...e, ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '' }),
      pricing: pricingFromEnv(env),
      payments: paymentsFromEnv(env),
    });
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
  const register = async (email = `m${++n}@example.com`) => {
    const res = await call('POST', '/api/auth/register', undefined, { email, password: 'correct horse', name: `Пользователь ${n}` });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return { token: res.json.token as string, id: res.json.user.id as string };
  };
  const buy = async (token: string, points: number) => {
    const created = await call('POST', '/api/payments', token, { points });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    await call('POST', `/api/dev/fake-payments/${created.json.payment.id}`, token, { result: 'succeeded' });
    return created.json.payment.id as string;
  };

  test('не-администратор не видит денежные разделы', async () => {
    const user = await register();
    for (const url of ['/api/admin/money/summary', '/api/admin/money/payments', '/api/admin/money/ledger']) {
      assert.equal((await call('GET', url, user.token)).status, 403, url);
    }
    assert.equal((await call('POST', `/api/admin/money/payments/${randomUUID()}/refund`, user.token, { points: 1, note: 'x' })).status, 403);
  });

  test('сводка за период сходится; журнал и платежи с фильтрами; карточка пользователя со счётом', async () => {
    const admin = await register('boss@example.com');
    const author = await register();
    const fan = await register();
    await buy(fan.token, 500);
    await buy(author.token, 600);
    assert.equal((await call('POST', '/api/tips', fan.token, { authorId: author.id, amount: 100, expectedCost: 100 })).status, 201);
    const payout = (await call('POST', '/api/payouts', author.token, { points: 500 })).json.payout;
    await call('POST', `/api/admin/payouts/${payout.id}/decision`, admin.token, { decision: 'paid', note: 'Перевод' });

    const s = await call('GET', '/api/admin/money/summary', admin.token);
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.reconciled, true, JSON.stringify(s.json.problems));
    assert.equal(s.json.purchasesRub, 1100);
    assert.equal(s.json.tipCommission, 20);
    assert.equal(s.json.paidOutRub, 475);
    assert.equal(s.json.payoutFeesRub, 25);
    assert.equal(s.json.pointsOnAccounts, 400 + 680 - 500);
    const past = await call('GET', '/api/admin/money/summary?from=2020-01-01&to=2020-02-01', admin.token);
    assert.equal(past.json.purchasesRub, 0);

    const payments = await call('GET', `/api/admin/money/payments?user=${fan.id}`, admin.token);
    assert.equal(payments.json.payments.length, 1);
    assert.equal(payments.json.payments[0].points, 500);
    const ledger = await call('GET', `/api/admin/money/ledger?user=${author.id}&kind=tip`, admin.token);
    assert.equal(ledger.json.items.length, 1);
    assert.equal(ledger.json.items[0].kind, 'tip');

    const card = await call('GET', `/api/admin/users/${author.id}`, admin.token);
    assert.equal(card.json.wallet.balance, 180);
    assert.ok(card.json.ledger.length >= 3);
    assert.equal(card.json.payout, null);
  });

  test('возврат: не больше остатка платежа и доступного; повторное уведомление ничего не меняет', async () => {
    const admin = await register('boss@example.com');
    const user = await register();
    const other = await register();
    const paymentId = await buy(user.token, 300);
    await call('POST', '/api/tips', user.token, { authorId: other.id, amount: 200, expectedCost: 200 });
    const refund = (points: number) => call('POST', `/api/admin/money/payments/${paymentId}/refund`, admin.token, { points, note: 'Просьба пользователя' });
    assert.equal((await refund(400)).status, 400, 'больше платежа');
    assert.equal((await refund(150)).status, 400, 'больше доступного');
    const ok = await refund(100);
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.refund.status, 'succeeded');
    const wallet = async () => (await call('GET', '/api/wallet', user.token)).json;
    assert.equal((await wallet()).balance, 0);
    assert.equal((db.prepare('SELECT refunded_kop FROM payments WHERE id = ?').get(paymentId) as any).refunded_kop, 10000);

    const providerId = (db.prepare('SELECT provider_id FROM refunds').get() as any).provider_id;
    const notify = await call('POST', '/api/payments/yookassa/notify', undefined, { event: 'refund.succeeded', object: { id: providerId } }, '185.71.76.10');
    assert.equal(notify.status, 200);
    assert.equal((await wallet()).balance, 0, 'повторно не списано');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ledger_tx WHERE kind = 'refund'").get() as any).n, 1);
    assert.equal((await refund(250)).status, 400, 'остаток платежа — 200');
    const s = await call('GET', '/api/admin/money/summary', admin.token);
    assert.equal(s.json.refundsRub, 100);
    assert.equal(s.json.reconciled, true, JSON.stringify(s.json.problems));
  });

  test('новая комиссия действует на следующие операции, прошлые не пересчитываются', async () => {
    const admin = await register('boss@example.com');
    const author = await register();
    const fan = await register();
    await buy(fan.token, 300);
    await call('POST', '/api/tips', fan.token, { authorId: author.id, amount: 100, expectedCost: 100 });
    const put = await call('PUT', '/api/admin/settings', admin.token, { values: { SALE_COMMISSION_PCT: '50' } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    await call('POST', '/api/tips', fan.token, { authorId: author.id, amount: 100, expectedCost: 100 });
    const shares = (db.prepare('SELECT author_share FROM tips ORDER BY created_at').all() as any[]).map((r) => r.author_share);
    assert.deepEqual(shares, [80, 50]);
    assert.equal((await call('GET', '/api/wallet', author.token)).json.balance, 130);
  });
});
