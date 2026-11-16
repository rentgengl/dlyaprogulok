import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
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
