/**
 * API монетизации: цены, счёт в баллах, история операций (specs/002-monetization/contracts/api.md).
 * Покупка баллов, премии, вывод и платные маршруты добавляются сюда же по мере реализации историй.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './app.ts';
import { HttpError } from './errors.ts';
import { available, balanceOf, heldOf, userAccount } from './ledger.ts';
import type { Mailer } from './mail.ts';
import type { Pricing } from './pricing.ts';
import type { PaymentsConfig } from './settings.ts';

export interface MoneyContext {
  db: DatabaseSync;
  requireUser: (req: FastifyRequest) => User;
  requireVerified: (req: FastifyRequest) => User;
  monthWindow: (nowMs: number) => { start: Date; end: Date };
  pricing: () => Pricing;
  payments: () => PaymentsConfig;
  mailer: () => Mailer | null;
  appUrl: () => string;
}

/** Остаток для профиля: в /api/me и везде, где приложению нужно число баллов. */
export function walletBrief(db: DatabaseSync, userId: string) {
  return { balance: balanceOf(db, userId), available: available(db, userId) };
}

/** Платное действие: подтверждённая почта, счёт не заморожен, платежи включены. */
export function requireSpender(ctx: MoneyContext, req: FastifyRequest): User {
  const user = ctx.requireVerified(req);
  const row = ctx.db.prepare('SELECT blocked_at FROM users WHERE id = ?').get(user.id) as { blocked_at: string | null } | undefined;
  if (row?.blocked_at) throw new HttpError(403, 'Счёт заморожен: аккаунт заблокирован.', 'WALLET_FROZEN');
  if (!ctx.payments().provider) throw new HttpError(503, 'Платные функции сейчас недоступны.', 'PAYMENTS_DISABLED');
  return user;
}

/**
 * Пользователь подтвердил цену expected; если сервер насчитал больше, ничего не списывается (SC-002).
 * Меньше — допустимо: списывается фактическая цена.
 */
export function checkExpected(cost: number, expected: number | undefined) {
  if (expected === undefined || cost > expected) {
    throw new HttpError(409, `Цена изменилась: ${cost} баллов. Подтвердите ещё раз.`, 'PRICE_CHANGED', { cost });
  }
}

const KIND_TITLES: Record<string, [string, string]> = {
  // [трата, поступление]
  topup: ['Покупка баллов', 'Покупка баллов'],
  charge: ['Генерация', 'Генерация'],
  route_purchase: ['Открытие маршрута', 'Продажа маршрута'],
  tip: ['Премия автору', 'Премия от читателя'],
  payout: ['Вывод', 'Вывод'],
  refund: ['Возврат платежа', 'Возврат платежа'],
};

const parseMeta = (raw: string | null): Record<string, any> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export function registerMoney(app: FastifyInstance, ctx: MoneyContext) {
  const { db } = ctx;

  function pendingPayout(userId: string) {
    const r = db.prepare("SELECT * FROM payout_requests WHERE user_id = ? AND status = 'open'").get(userId) as any;
    return r
      ? { id: r.id, points: r.points, feePct: r.fee_pct, payoutRub: r.payout_kop / 100, status: r.status, createdAt: r.created_at }
      : null;
  }

  /** Доход автора за календарный месяц по Москве: доли от продаж и премий. */
  function incomeThisMonth(userId: string): number {
    const { start, end } = ctx.monthWindow(Date.now());
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
         WHERE e.account = ? AND e.amount > 0 AND t.kind IN ('route_purchase', 'tip') AND e.created_at >= ? AND e.created_at < ?`,
      )
      .get(userAccount(userId), start.toISOString(), end.toISOString()) as { s: number };
    return row.s;
  }

  app.get('/api/pricing', async () => {
    const p = ctx.pricing();
    return {
      route3h: p.route3h,
      story: p.story,
      narration2min: p.narration2min,
      saleCommissionPct: p.saleCommissionPct,
      payoutCommissionPct: p.payoutCommissionPct,
      routePrice: { min: p.routePriceMin, max: p.routePriceMax },
      tip: { min: p.tipMin, max: p.tipMax },
      topup: { min: p.topupMin, max: p.topupMax },
      payoutMin: p.payoutMin,
      paymentsEnabled: !!ctx.payments().provider,
    };
  });

  app.get('/api/wallet', async (req) => {
    const user = ctx.requireUser(req);
    const balance = balanceOf(db, user.id);
    return {
      balance,
      available: available(db, user.id),
      frozen: heldOf(db, user.id, 'payout') + heldOf(db, user.id, 'refund'),
      reserved: heldOf(db, user.id, 'charge'),
      pendingPayout: pendingPayout(user.id),
      incomeThisMonth: incomeThisMonth(user.id),
    };
  });

  app.get('/api/wallet/history', async (req) => {
    const user = ctx.requireUser(req);
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const rows = db
      .prepare(
        `SELECT e.id, e.amount, e.created_at, t.kind, t.meta FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
         WHERE e.account = ? ${q.before ? 'AND e.id < ?' : ''} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...[userAccount(user.id), ...(q.before ? [q.before] : []), q.limit + 1]) as any[];
    const items = rows.slice(0, q.limit).map((r) => {
      const meta = parseMeta(r.meta);
      const titles = KIND_TITLES[r.kind] ?? [r.kind, r.kind];
      return {
        id: r.id,
        kind: r.kind,
        amount: r.amount,
        createdAt: r.created_at,
        title: meta.title ?? titles[r.amount < 0 ? 0 : 1],
        route: meta.routeId ? { id: meta.routeId, title: meta.routeTitle ?? '' } : null,
        counterparty: meta.counterpartyId ? { id: meta.counterpartyId, name: meta.counterpartyName ?? '' } : null,
        // Комиссия видна только получателю дохода.
        commission: r.amount > 0 && typeof meta.commission === 'number' ? meta.commission : null,
        message: r.amount > 0 && meta.message ? meta.message : null,
      };
    });
    return { items, next: rows.length > q.limit ? items[items.length - 1]!.id : null };
  });
}
