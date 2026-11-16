/**
 * API монетизации: цены, счёт в баллах, история операций (specs/002-monetization/contracts/api.md).
 * Покупка баллов, премии, вывод и платные маршруты добавляются сюда же по мере реализации историй.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './app.ts';
import { tx } from './db.ts';
import { HttpError } from './errors.ts';
import { available, balanceOf, heldOf, post, release, userAccount } from './ledger.ts';
import type { Mailer } from './mail.ts';
import { createGateway, isYookassaIp, type FakeGateway, type PaymentGateway, type ProviderPayment } from './payments.ts';
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
  log: FastifyBaseLogger;
}

const nowIso = () => new Date().toISOString();
/** Опрос статуса у ЮKassa — не чаще раза в 5 с на платёж. */
const POLL_MS = 5_000;
/** Сверка зависших платежей и резервов. */
const SWEEP_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

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

  // Шлюз пересоздаётся, когда в админке меняются настройки платежей.
  let cached: { cfg: PaymentsConfig; gw: PaymentGateway | null } | null = null;
  const gateway = (): PaymentGateway | null => {
    const cfg = ctx.payments();
    if (!cached || cached.cfg !== cfg) cached = { cfg, gw: createGateway(cfg, ctx.appUrl) };
    return cached.gw;
  };
  app.decorate('paymentGateway', gateway);

  // ---------- Покупка баллов ----------

  const serializePayment = (r: any) => ({
    id: r.id,
    status: r.status,
    points: r.points,
    createdAt: r.created_at,
    confirmationUrl: r.status === 'pending' ? r.confirmation_url : null,
    cancelReason: r.cancel_reason ?? null,
  });

  /**
   * Применяет статус платежа из API ЮKassa. Начисление идемпотентно: переход в succeeded возможен
   * только из created/pending, в одной транзакции с проводкой (повторное уведомление ничего не меняет).
   */
  function applyProviderStatus(paymentId: string, pp: ProviderPayment, log: FastifyBaseLogger) {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
    if (!row) return;
    const ts = nowIso();
    if (pp.metadataId && pp.metadataId !== row.id) {
      log.error({ payment: row.id, providerId: pp.providerId }, 'платёж ЮKassa относится к другому заказу');
      return;
    }
    if (pp.status === 'succeeded' && pp.paid) {
      if (pp.amountKop !== row.amount_kop) {
        const r = db
          .prepare("UPDATE payments SET status = 'mismatch', checked_at = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'pending')")
          .run(ts, ts, row.id);
        if (Number(r.changes)) log.error({ payment: row.id, expected: row.amount_kop, got: pp.amountKop }, 'сумма платежа не совпала, баллы не начислены');
        return;
      }
      tx(db, () => {
        const r = db
          .prepare("UPDATE payments SET status = 'succeeded', checked_at = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'pending')")
          .run(ts, ts, row.id);
        if (!Number(r.changes)) return;
        const txId = post(db, {
          kind: 'topup',
          refType: 'payment',
          refId: row.id,
          actorId: row.user_id,
          meta: { points: row.points },
          entries: [
            { account: 'sys:yookassa', amount: -row.points },
            { account: userAccount(row.user_id), amount: row.points },
          ],
        });
        db.prepare('UPDATE payments SET ledger_tx_id = ? WHERE id = ?').run(txId, row.id);
      });
      return;
    }
    if (pp.status === 'canceled') {
      db.prepare(
        "UPDATE payments SET status = 'canceled', cancel_reason = ?, checked_at = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'pending')",
      ).run(pp.cancelReason ?? null, ts, ts, row.id);
      return;
    }
    db.prepare('UPDATE payments SET checked_at = ? WHERE id = ?').run(ts, row.id);
  }

  /** Сверка одного платежа с ЮKassa; сбой сети — только в лог. */
  async function refreshPayment(row: any, log: FastifyBaseLogger) {
    const gw = gateway();
    if (!gw || !row.provider_id || !['created', 'pending'].includes(row.status)) return;
    try {
      applyProviderStatus(row.id, await gw.getPayment(row.provider_id), log);
    } catch (err) {
      log.warn(err, 'не удалось сверить платёж');
      db.prepare('UPDATE payments SET checked_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
  }

  app.post('/api/payments', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = requireSpender(ctx, req);
    const p = ctx.pricing();
    const { points } = z
      .object({
        points: z
          .number()
          .int('Количество баллов — целое число')
          .min(p.topupMin, `Минимум ${p.topupMin} баллов`)
          .max(p.topupMax, `Максимум ${p.topupMax} баллов`),
      })
      .parse(req.body);
    const gw = gateway()!;
    const id = randomUUID();
    const ts = nowIso();
    db.prepare(
      "INSERT INTO payments (id, user_id, points, amount_kop, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)",
    ).run(id, user.id, points, points * 100, ts, ts);
    try {
      const created = await gw.createPayment({
        id,
        amountKop: points * 100,
        description: `Баллы сервиса «Для прогулок», ${points} шт.`,
        returnUrl: `${ctx.appUrl()}/wallet?payment=${id}`,
        email: user.email,
        receipt: ctx.payments().receipt,
      });
      db.prepare("UPDATE payments SET status = 'pending', provider_id = ?, confirmation_url = ?, updated_at = ? WHERE id = ?").run(
        created.providerId,
        created.confirmationUrl,
        nowIso(),
        id,
      );
    } catch (err) {
      req.log.error(err, 'не удалось создать платёж');
      db.prepare("UPDATE payments SET status = 'canceled', cancel_reason = 'gateway_error', updated_at = ? WHERE id = ?").run(nowIso(), id);
      throw new HttpError(502, 'Не удалось создать платёж, попробуйте позже');
    }
    return reply.status(201).send({ payment: serializePayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(id)) });
  });

  const ownPayment = (id: string, user: User) => {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as any;
    if (!row || row.user_id !== user.id) throw new HttpError(404, 'Платёж не найден');
    return row;
  };

  app.get('/api/payments/:id', async (req) => {
    const user = ctx.requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    let row = ownPayment(id, user);
    const checked = row.checked_at ? Date.parse(row.checked_at) : 0;
    if (row.status === 'pending' && Date.now() - checked >= POLL_MS) {
      await refreshPayment(row, req.log);
      row = ownPayment(id, user);
    }
    return { payment: serializePayment(row) };
  });

  /**
   * Уведомления ЮKassa. Тело не подписано, поэтому из него берётся только id, а статус — из API.
   * Ответ всегда 200 (иначе ЮKassa повторяет), кроме чужого адреса отправителя.
   */
  app.post('/api/payments/yookassa/notify', async (req, reply) => {
    if (ctx.payments().checkIp && !isYookassaIp(req.ip)) {
      req.log.warn({ ip: req.ip }, 'уведомление ЮKassa с чужого адреса');
      return reply.status(403).send({ error: 'Forbidden' });
    }
    try {
      const body = (req.body ?? {}) as { event?: string; object?: { id?: string } };
      const providerId = typeof body.object?.id === 'string' ? body.object.id : null;
      if (!providerId || !body.event?.startsWith('payment.')) return reply.status(200).send({ ok: true });
      const row = db.prepare('SELECT * FROM payments WHERE provider_id = ?').get(providerId) as any;
      if (!row) {
        req.log.warn({ providerId }, 'уведомление о неизвестном платеже');
        return reply.status(200).send({ ok: true });
      }
      const gw = gateway();
      if (gw) applyProviderStatus(row.id, await gw.getPayment(providerId), req.log);
    } catch (err) {
      req.log.error(err, 'ошибка обработки уведомления ЮKassa');
    }
    return reply.status(200).send({ ok: true });
  });

  /** Только для PAYMENTS_PROVIDER=fake: кнопки «Оплатить» и «Отменить» на экране «Баллы». */
  app.post('/api/dev/fake-payments/:id', async (req, reply) => {
    const gw = gateway();
    if (gw?.name !== 'fake') return reply.status(404).send({ error: 'Не найдено' });
    const user = ctx.requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { result } = z.object({ result: z.enum(['succeeded', 'canceled']) }).parse(req.body);
    const row = ownPayment(id, user);
    if (!row.provider_id) throw new HttpError(409, 'Платёж ещё не создан в шлюзе');
    const fake = gw as FakeGateway;
    if (result === 'succeeded') fake.succeed(row.provider_id);
    else fake.cancel(row.provider_id, 'canceled_by_user');
    applyProviderStatus(row.id, await fake.getPayment(row.provider_id), req.log);
    return { payment: serializePayment(ownPayment(id, user)) };
  });

  // ---------- Фоновая сверка ----------

  /**
   * Платежи pending моложе суток — сверка с ЮKassa; created без шлюза старше часа — отмена.
   * Резервы генерации без живой задачи или запроса снимаются (research R2).
   */
  async function sweep(log: FastifyBaseLogger) {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    for (const row of db
      .prepare("SELECT * FROM payments WHERE status = 'pending' AND created_at >= ? ORDER BY created_at")
      .all(since) as any[]) {
      await refreshPayment(row, log);
    }
    for (const row of db.prepare("SELECT * FROM payments WHERE status = 'pending' AND created_at < ?").all(since) as any[]) {
      await refreshPayment(row, log);
    }
    db.prepare(
      "UPDATE payments SET status = 'canceled', cancel_reason = 'not_created', updated_at = ? WHERE status = 'created' AND created_at < ?",
    ).run(nowIso(), new Date(Date.now() - 60 * 60_000).toISOString());
    sweepHolds(db);
  }

  let timer: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    sweepHolds(db);
    timer = setInterval(() => void sweep(ctx.log).catch((err) => ctx.log.error(err)), SWEEP_MS);
    timer.unref();
    void sweep(ctx.log).catch((err) => ctx.log.error(err));
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });

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

/**
 * Зависшие резервы генерации: задача уже не идёт (удалена вместе с маршрутом, упала до списания)
 * или синхронный запрос прервался падением сервера. Такие резервы снимаются, баллы возвращаются.
 */
export function sweepHolds(db: DatabaseSync): number {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT h.id FROM holds h WHERE h.status = 'active' AND h.kind = 'charge' AND (
         (h.ref_type = 'job' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = h.ref_id AND j.status IN ('queued', 'running')))
         OR (h.ref_type IN ('request', 'point') AND h.created_at < ?)
       )`,
    )
    .all(stale) as { id: string }[];
  for (const r of rows) release(db, r.id);
  return rows.length;
}
