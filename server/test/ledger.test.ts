import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from '../src/db.ts';
import {
  available,
  balanceOf,
  capture,
  findHold,
  heldOf,
  hold,
  post,
  reconcile,
  release,
  spend,
  userAccount,
} from '../src/ledger.ts';
import { splitShare } from '../src/pricing.ts';

/** Покупка баллов так, как её проводит платёж: запись payments и проводка topup. */
function topup(db: DatabaseSync, userId: string, points: number) {
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
}

const charge = (userId: string, amount: number) => ({
  kind: 'charge' as const,
  entries: [
    { account: userAccount(userId), amount: -amount },
    { account: 'sys:revenue' as const, amount },
  ],
});

describe('журнал баллов', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  test('операция: сумма проводок 0, остаток равен сумме проводок', () => {
    topup(db, 'a', 300);
    assert.equal(balanceOf(db, 'a'), 300);
    assert.throws(
      () =>
        post(db, {
          kind: 'charge',
          entries: [
            { account: userAccount('a'), amount: -10 },
            { account: 'sys:revenue', amount: 9 },
          ],
        }),
      /должна быть 0/,
    );
    assert.throws(() => post(db, { kind: 'charge', entries: [{ account: 'sys:revenue', amount: 1 }] }), /две/);
    assert.throws(
      () =>
        post(db, {
          kind: 'charge',
          entries: [
            { account: userAccount('a'), amount: -1.5 },
            { account: 'sys:revenue', amount: 1.5 },
          ],
        }),
      /целыми/,
    );
    assert.deepEqual(reconcile(db), []);
  });

  test('остаток не уходит в минус даже при прямой проводке', () => {
    topup(db, 'a', 10);
    assert.throws(() => tx(db, () => post(db, charge('a', 11))));
    assert.equal(balanceOf(db, 'a'), 10);
    assert.deepEqual(reconcile(db), []);
  });

  test('резервы: второй на последние баллы получает отказ, частичное списание и снятие остатка', () => {
    topup(db, 'a', 100);
    const h1 = tx(db, () => hold(db, { userId: 'a', kind: 'charge', amount: 80, refType: 'job', refId: 'j1' }));
    assert.equal(available(db, 'a'), 20);
    assert.throws(
      () => tx(db, () => hold(db, { userId: 'a', kind: 'charge', amount: 30, refType: 'job', refId: 'j2' })),
      (err: any) => err.code === 'INSUFFICIENT_POINTS' && err.status === 402 && err.extra.need === 30 && err.extra.available === 20,
    );
    assert.throws(() => tx(db, () => spend(db, 'a', 30, charge('a', 30))), (err: any) => err.code === 'INSUFFICIENT_POINTS');

    // Перезапуск: резерв задачи находится, второй не создаётся.
    assert.equal(findHold(db, 'job', 'j1')?.id, h1.id);

    tx(db, () => capture(db, h1.id, 30, charge('a', 30)));
    assert.equal(balanceOf(db, 'a'), 70);
    assert.equal(heldOf(db, 'a'), 50);
    assert.equal(available(db, 'a'), 20);
    assert.throws(() => tx(db, () => capture(db, h1.id, 60, charge('a', 60))), /больше резерва/);
    assert.throws(() => tx(db, () => capture(db, h1.id, 5, charge('a', 6))), /не совпадают/);

    tx(db, () => capture(db, h1.id, 10, charge('a', 10), { close: true }));
    assert.equal(balanceOf(db, 'a'), 60);
    assert.equal(heldOf(db, 'a'), 0);
    assert.equal(findHold(db, 'job', 'j1'), undefined);
    assert.throws(() => tx(db, () => capture(db, h1.id, 1, charge('a', 1))), /закрыт/);

    const h2 = tx(db, () => hold(db, { userId: 'a', kind: 'payout', amount: 60 }));
    assert.equal(available(db, 'a'), 0);
    release(db, h2.id);
    assert.equal(available(db, 'a'), 60);
    assert.deepEqual(reconcile(db), []);
  });

  test('доля автора округляется вниз, остаток — комиссия', () => {
    assert.deepEqual(splitShare(53, 20), { author: 42, commission: 11 });
    assert.deepEqual(splitShare(100, 20), { author: 80, commission: 20 });
    assert.deepEqual(splitShare(10, 0), { author: 10, commission: 0 });
  });

  test('сверка находит подделанный остаток и расхождение с платежами', () => {
    topup(db, 'a', 300);
    tx(db, () => spend(db, 'a', 50, charge('a', 50)));
    assert.deepEqual(reconcile(db), []);
    db.prepare("UPDATE wallets SET balance = 999 WHERE user_id = 'a'").run();
    db.prepare("UPDATE payments SET points = 1 WHERE user_id = 'a'").run();
    const problems = reconcile(db);
    assert.ok(problems.some((p) => p.includes('остаток 999')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('Покупки баллов')), problems.join('\n'));
  });
});
