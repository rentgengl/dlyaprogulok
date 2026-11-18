import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';

process.env.NODE_ENV = 'test';

import type { AI } from '../src/ai.ts';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { reconcile } from '../src/ledger.ts';
import type { Mail } from '../src/mail.ts';
import type { GeoServices } from '../src/services.ts';
import { paymentsFromEnv, pricingFromEnv } from '../src/settings.ts';

const START = { lat: 55.75, lng: 37.62 };
const PHOTO = {
  url: 'https://upload.wikimedia.org/x.jpg',
  author: 'Иван',
  license: 'CC BY-SA 4.0',
  source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
};

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

const ai: AI = {
  selectStops: async () => ({
    title: 'Прогулка',
    description: 'Описание',
    stops: [
      { candidateId: 'c1', teaser: 'Первая' },
      { candidateId: 'c2', teaser: 'Вторая' },
    ],
  }),
  writeStory: async ({ name }) => `Рассказ о ${name}`,
};

describe('платные маршруты', () => {
  let dir: string;
  let app: FastifyInstance;
  let db: DatabaseSync;
  let mails: Mail[];
  let uploads: string;
  let n = 0;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rasskazhi-paid-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => app?.close());

  beforeEach(async () => {
    mails = [];
    const sub = mkdtempSync(path.join(dir, 't-'));
    db = openDb(path.join(sub, 'db.sqlite'));
    const env = { PAYMENTS_PROVIDER: 'fake' };
    uploads = path.join(sub, 'uploads');
    app = await buildApp({
      db,
      geo,
      ai,
      tts: { name: 'тестовый голос', synthesize: async () => Buffer.from([0xff, 0xe3, 0x18, 0x00, ...new Array(68).fill(0)]) },
      uploadsDir: uploads,
      mailer: { name: 'тест', send: async (m) => void mails.push(m) },
      appUrl: 'https://dlyaprogulok.ru',
      routeMonthlyLimit: 0,
      adminEmails: ['boss@example.com'],
      pricing: pricingFromEnv(env),
      payments: paymentsFromEnv(env),
    });
  });

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: res.body && res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : null };
  };

  const register = async (email = `p${++n}@example.com`) => {
    const res = await call('POST', '/api/auth/register', undefined, { email, password: 'correct horse', name: `Пользователь ${n}` });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // Почта подтверждена: платные действия доступны.
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), res.json.user.id);
    return { token: res.json.token as string, id: res.json.user.id as string, email };
  };

  const buy = async (token: string, points: number) => {
    const created = await call('POST', '/api/payments', token, { points });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const paid = await call('POST', `/api/dev/fake-payments/${created.json.payment.id}`, token, { result: 'succeeded' });
    assert.equal(paid.json.payment.status, 'succeeded');
  };

  /** Маршрут с двумя точками; у первой — рассказ, озвучка и фото (ручной рассказ платный, поэтому — напрямую). */
  const makeRoute = async (token: string) => {
    const res = await call('POST', '/api/routes/generate', token, { start: START, durationMin: 60 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const point = res.json.route.points[0].id as string;
    const file = `${randomUUID()}.mp3`;
    writeFileSync(path.join(uploads, file), Buffer.from([0xff, 0xe3, 0x18, 0x00]));
    db.prepare(
      `INSERT INTO media (id, point_id, kind, file_name, mime, size, is_narration, created_at)
       VALUES (?, ?, 'audio', ?, 'audio/mpeg', 4, 1, ?)`,
    ).run(randomUUID(), point, file, new Date().toISOString());
    db.prepare("UPDATE points SET story = 'Рассказ', story_source = 'author', photo = ? WHERE id = ?").run(JSON.stringify(PHOTO), point);
    return res.json.route.id as string;
  };

  const wallet = async (token: string) => (await call('GET', '/api/wallet', token)).json;
  const catalogIds = async (token?: string) => (await call('GET', '/api/routes', token)).json.routes.map((r: any) => r.id);
  const media = (url: string) => app.inject({ method: 'GET', url });

  /** Автор, администратор и одобренный платный маршрут за 100 баллов. */
  const approved = async (existingAdmin?: { token: string; id: string; email: string }) => {
    const author = await register();
    const admin = existingAdmin ?? (await register('boss@example.com'));
    const id = await makeRoute(author.token);
    assert.equal((await call('PUT', `/api/routes/${id}/price`, author.token, { price: 100 })).status, 200);
    const ok = await call('POST', `/api/admin/paid-routes/${id}/decision`, admin.token, { decision: 'approve' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    return { author, admin, id };
  };

  test('цена → на проверке и не в каталоге; одобрение публикует маршрут с ценой и пишет автору', async () => {
    const author = await register();
    const other = await register();
    const admin = await register('boss@example.com');
    const id = await makeRoute(author.token);
    // Маршрут был открыт бесплатно, потом автор назначает цену.
    await call('PATCH', `/api/routes/${id}`, author.token, { isPublic: true });
    assert.ok((await catalogIds()).includes(id));

    assert.equal((await call('PUT', `/api/routes/${id}/price`, author.token, { price: 10 })).status, 400, 'ниже минимума');
    assert.equal((await call('PUT', `/api/routes/${id}/price`, author.token, { price: 5000 })).status, 400, 'выше максимума');
    assert.equal((await call('PUT', `/api/routes/${id}/price`, other.token, { price: 100 })).status, 404, 'чужой маршрут');
    const set = await call('PUT', `/api/routes/${id}/price`, author.token, { price: 100 });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.route.price, 100);
    assert.equal(set.json.route.sale.status, 'pending');
    assert.ok(!(await catalogIds()).includes(id), 'на проверке — не в каталоге');
    assert.equal((await call('GET', `/api/routes/${id}`, other.token)).status, 404, 'до одобрения не виден');

    assert.equal((await call('GET', '/api/admin/paid-routes', other.token)).status, 403);
    assert.equal((await call('POST', `/api/admin/paid-routes/${id}/decision`, other.token, { decision: 'approve' })).status, 403);
    const queue = await call('GET', '/api/admin/paid-routes?status=pending', admin.token);
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.json.routes.map((r: any) => r.id), [id]);
    assert.equal(queue.json.routes[0].points.length, 2, 'администратор видит содержимое');

    mails.length = 0;
    const ok = await call('POST', `/api/admin/paid-routes/${id}/decision`, admin.token, { decision: 'approve' });
    assert.equal(ok.status, 200);
    const listed = (await call('GET', '/api/routes')).json.routes.find((r: any) => r.id === id);
    assert.equal(listed.price, 100);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, author.email);
    assert.match(mails[0]!.subject, /одобрен/i);

    // Новая цена у одобренного маршрута действует сразу, без проверки.
    const changed = await call('PUT', `/api/routes/${id}/price`, author.token, { price: 150 });
    assert.equal(changed.json.route.sale.status, 'approved');
    assert.equal((await call('GET', '/api/routes')).json.routes.find((r: any) => r.id === id).price, 150);
  });

  test('одобрение приватного маршрута публикует его; отклонение — приватный и бесплатный, письмо с причиной', async () => {
    const author = await register();
    const admin = await register('boss@example.com');
    const a = await makeRoute(author.token);
    const b = await makeRoute(author.token);
    await call('PUT', `/api/routes/${a}/price`, author.token, { price: 100 });
    await call('PUT', `/api/routes/${b}/price`, author.token, { price: 100 });
    await call('POST', `/api/admin/paid-routes/${a}/decision`, admin.token, { decision: 'approve' });
    assert.ok((await catalogIds()).includes(a));
    assert.equal((db.prepare('SELECT is_public FROM routes WHERE id = ?').get(a) as any).is_public, 1);

    assert.equal((await call('POST', `/api/admin/paid-routes/${b}/decision`, admin.token, { decision: 'reject' })).status, 400, 'нужна причина');
    mails.length = 0;
    const no = await call('POST', `/api/admin/paid-routes/${b}/decision`, admin.token, { decision: 'reject', note: 'Мало рассказов' });
    assert.equal(no.status, 200);
    const row = db.prepare('SELECT is_public, price, sale_status, sale_note FROM routes WHERE id = ?').get(b) as any;
    assert.deepEqual({ ...row }, { is_public: 0, price: null, sale_status: 'rejected', sale_note: 'Мало рассказов' });
    assert.equal(mails.length, 1);
    assert.match(mails[0]!.text, /Мало рассказов/);
  });

  test('без покупки — только превью: ни точек, ни экспорта, ни подсказок, ни оценки, ни файлов', async () => {
    const { author, admin, id } = await approved();
    const viewer = await register();
    for (const token of [undefined, viewer.token]) {
      const res = await call('GET', `/api/routes/${id}`, token);
      assert.equal(res.status, 200);
      const r = res.json.route;
      assert.equal(r.locked, true);
      assert.equal(r.price, 100);
      assert.deepEqual(r.points, []);
      assert.equal(r.geometry, null);
      assert.equal(r.finish, null);
      assert.equal(r.pointCount, 2);
      assert.deepEqual(r.cover, PHOTO, 'обложка с автором и лицензией');
      assert.ok(!JSON.stringify(r).includes('/media/'));
    }
    assert.equal((await call('GET', `/api/routes/${id}/export?format=gpx`, viewer.token)).status, 404);
    assert.equal((await call('GET', `/api/routes/${id}/suggestions`, viewer.token)).status, 404);
    assert.equal((await call('PUT', `/api/routes/${id}/rating`, viewer.token, { value: 5 })).status, 403);

    // Автор и администратор видят всё без покупки; ссылки на файлы подписаны.
    for (const token of [author.token, admin.token]) {
      const r = (await call('GET', `/api/routes/${id}`, token)).json.route;
      assert.equal(r.locked, false);
      assert.equal(r.points.length, 2);
    }
    const signed = (await call('GET', `/api/routes/${id}`, author.token)).json.route.points[0].narrationUrl as string;
    assert.match(signed, /^\/media\/[\w-]+\.mp3\?exp=\d+&sig=[0-9a-f]{64}$/);
    const bare = signed.split('?')[0]!;
    assert.equal((await media(signed)).statusCode, 200);
    assert.equal((await media(bare)).statusCode, 403, 'без подписи');
    const exp = Number(signed.match(/exp=(\d+)/)![1]);
    assert.equal((await media(signed.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`))).statusCode, 403, 'чужая подпись');
    assert.equal((await media(signed.replace(`exp=${exp}`, `exp=${exp + 1}`))).statusCode, 403, 'подпись от другого срока');
    const { createMediaSigner, mediaSigningKey } = await import('../src/media.ts');
    const expired = createMediaSigner(mediaSigningKey(db, {})).sign(bare.slice('/media/'.length), -20);
    assert.equal((await media(expired)).statusCode, 403, 'просроченная');

    // Файлы бесплатных маршрутов — как раньше, без подписи.
    const free = await makeRoute(author.token);
    const freeUrl = (await call('GET', `/api/routes/${free}`, author.token)).json.route.points[0].narrationUrl as string;
    assert.doesNotMatch(freeUrl, /sig=/);
    assert.equal((await media(freeUrl)).statusCode, 200);
  });

  test('покупка: −100 у покупателя, +80 автору, +20 сервису, полный доступ навсегда', async () => {
    const { author, id } = await approved();
    const buyer = await register();
    await buy(buyer.token, 300);
    assert.equal((await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 50 })).json.code, 'PRICE_CHANGED');
    const res = await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 100 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.route.locked, false);
    assert.equal(res.json.route.points.length, 2);
    assert.equal(res.json.route.owned, true);
    assert.equal((await wallet(buyer.token)).balance, 200);
    assert.equal((await wallet(author.token)).balance, 80);
    const revenue = db
      .prepare("SELECT SUM(e.amount) AS s FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.kind = 'route_purchase' AND e.account = 'sys:revenue'")
      .get() as any;
    assert.equal(revenue.s, 20);
    assert.deepEqual(reconcile(db), []);

    assert.equal((await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 100 })).json.code, 'ALREADY_OWNED');
    await buy(author.token, 100);
    const own = await call('POST', `/api/routes/${id}/purchase`, author.token, { expectedCost: 100 });
    assert.equal(own.status, 409);
    assert.equal((await wallet(buyer.token)).balance, 200, 'повторная покупка ничего не списала');

    const listed = (await call('GET', '/api/routes', buyer.token)).json.routes.find((r: any) => r.id === id);
    assert.equal(listed.owned, true);
    assert.equal((await call('PUT', `/api/routes/${id}/rating`, buyer.token, { value: 5 })).status, 200, 'купивший может оценить');
    const narration = (await call('GET', `/api/routes/${id}`, buyer.token)).json.route.points[0].narrationUrl;
    assert.equal((await media(narration)).statusCode, 200);

    // Доступ сохраняется при смене цены и скрытии маршрута.
    await call('PUT', `/api/routes/${id}/price`, author.token, { price: 500 });
    await call('PATCH', `/api/routes/${id}`, author.token, { isPublic: false });
    assert.equal((await call('GET', `/api/routes/${id}`, buyer.token)).json.route.locked, false);
  });

  test('купить нельзя: на проверке, отклонён, снят с продажи, не хватает баллов, аккаунт заблокирован', async () => {
    const { author, admin, id } = await approved();
    const buyer = await register();
    const poor = await register();
    await buy(buyer.token, 500);
    const pending = await makeRoute(author.token);
    await call('PUT', `/api/routes/${pending}/price`, author.token, { price: 100 });
    assert.equal((await call('POST', `/api/routes/${pending}/purchase`, buyer.token, { expectedCost: 100 })).status, 404);
    const rejected = await makeRoute(author.token);
    await call('PUT', `/api/routes/${rejected}/price`, author.token, { price: 100 });
    await call('POST', `/api/admin/paid-routes/${rejected}/decision`, admin.token, { decision: 'reject', note: 'нет' });
    assert.equal((await call('POST', `/api/routes/${rejected}/purchase`, buyer.token, { expectedCost: 100 })).status, 404);

    const short = await call('POST', `/api/routes/${id}/purchase`, poor.token, { expectedCost: 100 });
    assert.equal(short.status, 402);
    assert.equal(short.json.code, 'INSUFFICIENT_POINTS');

    // Покупатель до снятия с продажи сохраняет доступ, новые покупки невозможны.
    const early = await register();
    await buy(early.token, 100);
    assert.equal((await call('POST', `/api/routes/${id}/purchase`, early.token, { expectedCost: 100 })).status, 201);
    assert.equal((await call('POST', `/api/admin/paid-routes/${id}/decision`, admin.token, { decision: 'delist' })).status, 400);
    assert.equal((await call('POST', `/api/admin/paid-routes/${id}/decision`, admin.token, { decision: 'delist', note: 'Жалоба' })).status, 200);
    assert.ok(!(await catalogIds()).includes(id));
    assert.equal((await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 100 })).status, 404);
    assert.equal((await call('GET', `/api/routes/${id}`, early.token)).json.route.locked, false);

    // Заблокированный пользователь не может купить: сессии закрыты, счёт заморожен.
    const other = await approved(admin);
    await call('PATCH', `/api/admin/users/${buyer.id}`, admin.token, { blocked: true });
    const blocked = await call('POST', `/api/routes/${other.id}/purchase`, buyer.token, { expectedCost: 100 });
    assert.ok(blocked.status === 401 || blocked.json?.code === 'WALLET_FROZEN', `ответ ${blocked.status}`);
    assert.equal((db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(buyer.id) as any).balance, 500);
  });

  test('рассказ платного маршрута не подставляется в чужой маршрут о том же месте', async () => {
    const { id } = await approved();
    const secret = db.prepare('SELECT id FROM points WHERE route_id = ? ORDER BY position LIMIT 1').get(id) as any;
    db.prepare(
      "UPDATE points SET story = 'Секретный рассказ', story_source = 'ai_sourced', story_style = 'facts', story_version = 999 WHERE id = ?",
    ).run(secret.id);
    const other = await register();
    await buy(other.token, 100);
    const res = await call('POST', '/api/routes/generate', other.token, { start: START, durationMin: 60 });
    const pointId = res.json.route.points.find((p: any) => p.name === 'Храм').id;
    const story = await call('POST', `/api/points/${pointId}/story`, other.token, { fresh: false, expectedCost: 20 });
    assert.equal(story.status, 200, JSON.stringify(story.json));
    assert.equal(story.json.reused, false);
    assert.notEqual(story.json.route.points.find((p: any) => p.id === pointId).story, 'Секретный рассказ');

    // Тот же рассказ из бесплатного маршрута подставляется: условие поиска то же.
    db.prepare('UPDATE routes SET price = NULL, sale_status = NULL WHERE id = ?').run(id);
    db.prepare('UPDATE points SET story = NULL WHERE id = ?').run(pointId);
    const again = await call('POST', `/api/points/${pointId}/story`, other.token, { expectedCost: 20 });
    assert.equal(again.json.reused, true);
  });

  test('удаление маршрута с покупателями: у автора 404, у покупателя остаётся', async () => {
    const { author, id } = await approved();
    const buyer = await register();
    await buy(buyer.token, 100);
    await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 100 });
    assert.equal((await call('DELETE', `/api/routes/${id}`, author.token)).status, 204);
    assert.equal((await call('GET', `/api/routes/${id}`, author.token)).status, 404);
    assert.ok(!(await call('GET', '/api/routes/mine', author.token)).json.routes.some((r: any) => r.id === id));
    assert.ok(!(await catalogIds()).includes(id));
    const kept = await call('GET', `/api/routes/${id}`, buyer.token);
    assert.equal(kept.status, 200);
    assert.equal(kept.json.route.deletedByAuthor, true);
    assert.equal(kept.json.route.points.length, 2);
    assert.equal((await media(kept.json.route.points[0].narrationUrl)).statusCode, 200, 'файлы не удалены');
  });

  test('удаление аккаунта автора с продажами: предупреждение о баллах, обезличивание, покупатель сохраняет доступ', async () => {
    const { author, id } = await approved();
    const unsold = await makeRoute(author.token);
    const buyer = await register();
    await buy(buyer.token, 100);
    await call('POST', `/api/routes/${id}/purchase`, buyer.token, { expectedCost: 100 });

    const warn = await call('DELETE', '/api/me', author.token, { password: 'correct horse' });
    assert.equal(warn.status, 409);
    assert.equal(warn.json.code, 'HAS_POINTS');
    assert.equal(warn.json.balance, 80);
    assert.equal((await call('DELETE', '/api/me', author.token, { password: 'correct horse', force: true })).status, 204);

    assert.equal((await call('GET', '/api/me', author.token)).status, 401);
    assert.equal((await call('POST', '/api/auth/login', undefined, { email: author.email, password: 'correct horse' })).status, 401);
    const user = db.prepare('SELECT name, email, deleted_at FROM users WHERE id = ?').get(author.id) as any;
    assert.equal(user.name, 'Удалённый автор');
    assert.ok(user.deleted_at);
    assert.ok(!user.email.includes('example.com'));
    assert.equal(db.prepare('SELECT 1 FROM routes WHERE id = ?').get(unsold), undefined, 'непроданный маршрут удалён');
    const kept = (await call('GET', `/api/routes/${id}`, buyer.token)).json.route;
    assert.equal(kept.points.length, 2);
    assert.equal(kept.ownerName, 'Удалённый автор');
  });
});
