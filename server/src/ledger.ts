/**
 * Учёт баллов: операции с двойной записью, резервы и сверка (specs/002-monetization, research R1–R3).
 *
 * Каждая операция — ledger_tx и не меньше двух проводок ledger_entries с суммой 0. Счета: 'user:<id>'
 * и системные sys:*. Остаток пользователя хранится в wallets и меняется только здесь, в той же
 * транзакции SQLite, что и проводки. Функции не открывают транзакцию сами: вызывающий код оборачивает
 * всю операцию в tx(db, …), чтобы проверка остатка и списание были атомарными.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';

export type SystemAccount = 'sys:yookassa' | 'sys:revenue' | 'sys:payouts' | 'sys:refunds';
export type Account = `user:${string}` | SystemAccount;
export type LedgerKind = 'topup' | 'charge' | 'route_purchase' | 'tip' | 'payout' | 'refund';
export type HoldKind = 'charge' | 'payout' | 'refund';

export const userAccount = (userId: string): Account => `user:${userId}`;
const userOf = (account: string): string | null => (account.startsWith('user:') ? account.slice(5) : null);

const now = () => new Date().toISOString();

export interface PostInput {
  kind: LedgerKind;
  entries: { account: Account; amount: number }[];
  actorId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Для истории операций: название, маршрут, контрагент, комиссия, сообщение премии. */
  meta?: Record<string, unknown>;
}

/** Записывает операцию. Бросает, если суммы не целые, сумма проводок не 0 или остаток ушёл бы в минус. */
export function post(db: DatabaseSync, input: PostInput): string {
  const entries = input.entries.filter((e) => e.amount !== 0);
  if (entries.length < 2) throw new Error('Операция должна иметь хотя бы две ненулевые проводки');
  if (entries.some((e) => !Number.isInteger(e.amount))) throw new Error('Суммы проводок должны быть целыми');
  if (entries.reduce((s, e) => s + e.amount, 0) !== 0) throw new Error('Сумма проводок операции должна быть 0');

  const id = randomUUID();
  const ts = now();
  db.prepare('INSERT INTO ledger_tx (id, kind, actor_id, ref_type, ref_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    input.kind,
    input.actorId ?? null,
    input.refType ?? null,
    input.refId ?? null,
    input.meta ? JSON.stringify(input.meta) : null,
    ts,
  );
  const insert = db.prepare('INSERT INTO ledger_entries (tx_id, account, amount, created_at) VALUES (?, ?, ?, ?)');
  // CHECK (balance >= 0) в wallets не даёт уйти в минус даже при ошибке в вызывающем коде.
  // UPSERT не подходит: SQLite проверяет CHECK у вставляемой строки ещё до ON CONFLICT.
  const ensure = db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance, updated_at) VALUES (?, 0, ?)');
  const change = db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?');
  for (const e of entries) {
    insert.run(id, e.account, e.amount, ts);
    const user = userOf(e.account);
    if (user) {
      ensure.run(user, ts);
      change.run(e.amount, ts, user);
    }
  }
  return id;
}

export function balanceOf(db: DatabaseSync, userId: string): number {
  const row = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

/** Сумма активных резервов и заморозок; kind — только определённого вида. */
export function heldOf(db: DatabaseSync, userId: string, kind?: HoldKind): number {
  const row = (
    kind
      ? db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM holds WHERE user_id = ? AND status = 'active' AND kind = ?").get(userId, kind)
      : db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM holds WHERE user_id = ? AND status = 'active'").get(userId)
  ) as { n: number };
  return row.n;
}

/** Сколько можно потратить: остаток без резервов и заморозок. */
export const available = (db: DatabaseSync, userId: string): number => balanceOf(db, userId) - heldOf(db, userId);

export function insufficient(need: number, avail: number): HttpError {
  return new HttpError(402, `Не хватает баллов: нужно ${need}, доступно ${avail}.`, 'INSUFFICIENT_POINTS', {
    need,
    available: avail,
  });
}

export function requireAvailable(db: DatabaseSync, userId: string, amount: number) {
  const avail = available(db, userId);
  if (avail < amount) throw insufficient(amount, avail);
}

/** Трата без резерва (покупка маршрута, премия): проверяет доступный остаток и проводит операцию. */
export function spend(db: DatabaseSync, userId: string, amount: number, input: PostInput): string {
  const own = input.entries.filter((e) => e.account === userAccount(userId)).reduce((s, e) => s + e.amount, 0);
  if (own !== -amount) throw new Error('Проводки траты не совпадают с суммой');
  requireAvailable(db, userId, amount);
  return post(db, input);
}

export interface HoldRow {
  id: string;
  user_id: string;
  kind: HoldKind;
  amount: number;
  ref_type: string | null;
  ref_id: string | null;
  status: 'active' | 'captured' | 'released';
  created_at: string;
  updated_at: string;
}

/** Резерв или заморозка: деньги не двигаются, но тратить их нельзя. */
export function hold(
  db: DatabaseSync,
  input: { userId: string; kind: HoldKind; amount: number; refType?: string | null; refId?: string | null },
): HoldRow {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('Резерв должен быть целым положительным');
  requireAvailable(db, input.userId, input.amount);
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO holds (id, user_id, kind, amount, ref_type, ref_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, input.userId, input.kind, input.amount, input.refType ?? null, input.refId ?? null, ts, ts);
  return getHold(db, id)!;
}

export const getHold = (db: DatabaseSync, id: string): HoldRow | undefined =>
  db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow | undefined;

/** Активный резерв по объекту (задаче, запросу, заявке): после перезапуска сервера не создаётся второй. */
export const findHold = (db: DatabaseSync, refType: string, refId: string): HoldRow | undefined =>
  db
    .prepare("SELECT * FROM holds WHERE ref_type = ? AND ref_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(refType, refId) as HoldRow | undefined;

/**
 * Списание из резерва: проводка на amount (со счёта владельца резерва) и уменьшение резерва.
 * close — закрыть резерв после списания (остаток освобождается).
 */
export function capture(
  db: DatabaseSync,
  holdId: string,
  amount: number,
  input: Omit<PostInput, 'entries'> & { entries: PostInput['entries'] },
  opts: { close?: boolean } = {},
): string | null {
  const h = getHold(db, holdId);
  if (!h || h.status !== 'active') throw new Error('Резерв не найден или уже закрыт');
  if (!Number.isInteger(amount) || amount < 0 || amount > h.amount) throw new Error('Списание больше резерва');
  const own = input.entries.filter((e) => e.account === userAccount(h.user_id)).reduce((s, e) => s + e.amount, 0);
  if (own !== -amount) throw new Error('Проводки списания не совпадают с суммой');
  // В резерве хранится неизрасходованная часть; закрытый резерв (captured) её уже не держит.
  const rest = h.amount - amount;
  const status = opts.close || rest === 0 ? 'captured' : 'active';
  db.prepare('UPDATE holds SET amount = ?, status = ?, updated_at = ? WHERE id = ?').run(rest, status, now(), holdId);
  return amount > 0 ? post(db, input) : null;
}

/** Снять резерв без списания (ошибка, отмена, отклонённая заявка). */
export function release(db: DatabaseSync, holdId: string) {
  db.prepare("UPDATE holds SET status = 'released', updated_at = ? WHERE id = ? AND status = 'active'").run(now(), holdId);
}

/**
 * Сверка учёта (SC-003): пустой список — всё сходится.
 * 1) по каждой операции сумма проводок 0; 2) остаток каждого пользователя равен сумме его проводок;
 * 3) деньги ЮKassa в журнале равны успешным платежам за вычетом возвратов; 4) резервы не больше остатка.
 */
export function reconcile(db: DatabaseSync): string[] {
  const problems: string[] = [];
  for (const r of db
    .prepare('SELECT tx_id, SUM(amount) AS s FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) != 0')
    .all() as { tx_id: string; s: number }[]) {
    problems.push(`Операция ${r.tx_id}: сумма проводок ${r.s}, должна быть 0`);
  }
  for (const r of db
    .prepare(
      `SELECT w.user_id, w.balance, COALESCE((SELECT SUM(amount) FROM ledger_entries e WHERE e.account = 'user:' || w.user_id), 0) AS s
       FROM wallets w`,
    )
    .all() as { user_id: string; balance: number; s: number }[]) {
    if (r.balance !== r.s) problems.push(`Счёт ${r.user_id}: остаток ${r.balance}, по журналу ${r.s}`);
  }
  for (const r of db
    .prepare(
      `SELECT DISTINCT substr(account, 6) AS user_id FROM ledger_entries
       WHERE account LIKE 'user:%' AND substr(account, 6) NOT IN (SELECT user_id FROM wallets)`,
    )
    .all() as { user_id: string }[]) {
    problems.push(`Счёт ${r.user_id}: есть проводки, но нет остатка`);
  }
  const inJournal = -(
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries WHERE account = 'sys:yookassa'").get() as { s: number }
  ).s;
  const paid = (
    db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM payments WHERE status = 'succeeded' AND ledger_tx_id IS NOT NULL").get() as {
      s: number;
    }
  ).s;
  if (inJournal !== paid) problems.push(`Покупки баллов: в журнале ${inJournal}, по платежам ${paid}`);
  const refundedJournal = (
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries WHERE account = 'sys:refunds'").get() as { s: number }
  ).s;
  const refundedPayments = (
    db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM refunds WHERE status = 'succeeded'").get() as { s: number }
  ).s;
  if (refundedJournal !== refundedPayments) {
    problems.push(`Возвраты: в журнале ${refundedJournal}, по возвратам ЮKassa ${refundedPayments}`);
  }
  for (const r of db
    .prepare(
      `SELECT h.user_id, SUM(h.amount) AS held, COALESCE(w.balance, 0) AS balance FROM holds h
       LEFT JOIN wallets w ON w.user_id = h.user_id WHERE h.status = 'active' GROUP BY h.user_id HAVING SUM(h.amount) > COALESCE(w.balance, 0)`,
    )
    .all() as { user_id: string; held: number; balance: number }[]) {
    problems.push(`Счёт ${r.user_id}: резервов ${r.held} больше остатка ${r.balance}`);
  }
  return problems;
}
