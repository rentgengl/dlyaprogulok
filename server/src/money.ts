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
import { available, balanceOf, capture, getHold, heldOf, hold, post, release, spend, userAccount } from './ledger.ts';
import type { Mailer } from './mail.ts';
import {
  createGateway,
  GatewayError,
  isYookassaIp,
  type FakeGateway,
  type PaymentGateway,
  type ProviderPayment,
  type ProviderRefund,
} from './payments.ts';
import { payoutQuote, splitShare, type Pricing } from './pricing.ts';
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
  /** Маршруты из app.ts: загрузка строки, проверка автора и сериализация с учётом доступа. */
  routes: {
    load: (id: string) => any;
    owned: (id: string, user: User) => any;
    full: (row: any, viewer: User | null) => unknown;
    /** Полный доступ к содержимому (бесплатный открытый, свой, купленный). */
    canView: (row: any, viewer: User | null) => boolean;
    /** Маршруты автора из каталога. */
    listedBy: (ownerId: string, viewer: User | null) => unknown[];
  };
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

/** Что модуль денег отдаёт админке. */
export interface MoneyAdmin {
  /** Возврат с платежа через ЮKassa (FR-028); бросает HttpError 400, если сумма больше остатка платежа или доступного. */
  refund(input: { paymentId: string; points: number; note: string; adminId: string }, log: FastifyBaseLogger): Promise<any>;
}

export function registerMoney(app: FastifyInstance, ctx: MoneyContext): MoneyAdmin {
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
      if (providerId && body.event?.startsWith('refund.')) {
        const refund = db.prepare('SELECT * FROM refunds WHERE provider_id = ?').get(providerId) as any;
        const gw = gateway();
        if (refund && gw) applyRefundStatus(refund.id, await gw.getRefund(providerId), req.log);
        return reply.status(200).send({ ok: true });
      }
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

  // ---------- Платные маршруты ----------

  const routeParams = z.object({ id: z.string().uuid() });

  /**
   * Цена маршрута (FR-012, FR-012b). Число — заявка на проверку (pending); у одобренного маршрута новая
   * цена действует сразу. null — маршрут снова бесплатный.
   */
  app.put('/api/routes/:id/price', async (req) => {
    const user = ctx.requireVerified(req);
    const { id } = routeParams.parse(req.params);
    const p = ctx.pricing();
    const { price } = z
      .object({
        price: z
          .number()
          .int('Цена — целое число баллов')
          .min(p.routePriceMin, `Цена — от ${p.routePriceMin} баллов`)
          .max(p.routePriceMax, `Цена — не больше ${p.routePriceMax} баллов`)
          .nullable(),
      })
      .parse(req.body);
    // Чужой маршрут — как несуществующий (contracts/api.md), даже если он открыт в каталоге.
    const own = ctx.routes.load(id);
    if (!own || (own.owner_id !== user.id && !user.isAdmin)) throw new HttpError(404, 'Маршрут не найден');
    const row = ctx.routes.owned(id, user);
    const ts = nowIso();
    if (price === null) {
      db.prepare('UPDATE routes SET price = NULL, sale_status = NULL, sale_note = NULL, updated_at = ? WHERE id = ?').run(ts, id);
    } else {
      if (!db.prepare('SELECT 1 FROM points WHERE route_id = ? LIMIT 1').get(id)) {
        throw new HttpError(409, 'Добавьте в маршрут хотя бы одно место, прежде чем назначать цену');
      }
      const keepStatus = row.sale_status === 'approved' || row.sale_status === 'pending';
      db.prepare(
        `UPDATE routes SET price = ?, sale_status = ?, sale_note = ${keepStatus ? 'sale_note' : 'NULL'}, updated_at = ? WHERE id = ?`,
      ).run(price, keepStatus ? row.sale_status : 'pending', ts, id);
    }
    return { route: ctx.routes.full(ctx.routes.load(id), user) };
  });

  /** Открытие платного маршрута за баллы (FR-014, FR-016): цена минус комиссия — автору. */
  app.post('/api/routes/:id/purchase', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = requireSpender(ctx, req);
    const { id } = routeParams.parse(req.params);
    const { expectedCost } = z.object({ expectedCost: z.number().int().min(0).optional() }).parse(req.body ?? {});
    const row = ctx.routes.load(id);
    if (!row || row.deleted_at) throw new HttpError(404, 'Маршрут не найден');
    const owned = row.owner_id === user.id || db.prepare('SELECT 1 FROM route_purchases WHERE route_id = ? AND user_id = ?').get(id, user.id);
    if (owned) throw new HttpError(409, 'Маршрут уже открыт', 'ALREADY_OWNED');
    if (row.price === null || row.sale_status !== 'approved' || !row.is_public) throw new HttpError(404, 'Маршрут не найден');
    checkExpected(row.price, expectedCost);
    const price: number = row.price;
    const share = splitShare(price, ctx.pricing().saleCommissionPct);
    tx(db, () => {
      // Повторная проверка внутри транзакции: два одновременных запроса не спишут дважды.
      if (db.prepare('SELECT 1 FROM route_purchases WHERE route_id = ? AND user_id = ?').get(id, user.id)) {
        throw new HttpError(409, 'Маршрут уже открыт', 'ALREADY_OWNED');
      }
      const txId = spend(db, user.id, price, {
        kind: 'route_purchase',
        actorId: user.id,
        refType: 'route',
        refId: id,
        meta: { routeId: id, routeTitle: row.title, commission: share.commission },
        entries: [
          { account: userAccount(user.id), amount: -price },
          { account: userAccount(row.owner_id), amount: share.author },
          { account: 'sys:revenue', amount: share.commission },
        ],
      });
      db.prepare(
        'INSERT INTO route_purchases (route_id, user_id, price, author_share, ledger_tx_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, user.id, price, share.author, txId, nowIso());
    });
    return reply.status(201).send({ route: ctx.routes.full(ctx.routes.load(id), user) });
  });

  // ---------- Премии ----------

  /** Сообщение премии: без разметки и лишних пробелов (FR-022). */
  const cleanMessage = (raw: string | undefined) => {
    const text = (raw ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return text || null;
  };

  /** Премия автору или по маршруту (FR-018–FR-021): сумма минус комиссия — автору. */
  app.post('/api/tips', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = requireSpender(ctx, req);
    const p = ctx.pricing();
    const body = z
      .object({
        authorId: z.string().uuid(),
        routeId: z.string().uuid().optional(),
        amount: z
          .number()
          .int('Сумма — целое число баллов')
          .min(p.tipMin, `Премия — от ${p.tipMin} баллов`)
          .max(p.tipMax, `Премия — не больше ${p.tipMax} баллов`),
        message: z.string().max(2000).optional(),
        expectedCost: z.number().int().min(0).optional(),
      })
      .parse(req.body);
    const message = cleanMessage(body.message);
    if (message && message.length > 200) throw new HttpError(400, 'Сообщение — не длиннее 200 символов');
    if (body.authorId === user.id) throw new HttpError(400, 'Отправить премию самому себе нельзя');
    const author = db.prepare('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(body.authorId) as
      | { id: string; name: string }
      | undefined;
    if (!author) throw new HttpError(404, 'Автор не найден');
    let route: any = null;
    if (body.routeId) {
      route = ctx.routes.load(body.routeId);
      // Чужой приватный или неоткрытый платный маршрут — как несуществующий.
      if (!route || route.owner_id !== author.id || !ctx.routes.canView(route, user)) throw new HttpError(404, 'Маршрут не найден');
    }
    checkExpected(body.amount, body.expectedCost);
    const share = splitShare(body.amount, p.saleCommissionPct);
    const id = randomUUID();
    const ts = nowIso();
    tx(db, () => {
      const txId = spend(db, user.id, body.amount, {
        kind: 'tip',
        actorId: user.id,
        refType: 'tip',
        refId: id,
        meta: {
          ...(route ? { routeId: route.id, routeTitle: route.title } : {}),
          counterpartyId: user.id,
          counterpartyName: user.name,
          authorId: author.id,
          authorName: author.name,
          commission: share.commission,
          ...(message ? { message } : {}),
        },
        entries: [
          { account: userAccount(user.id), amount: -body.amount },
          { account: userAccount(author.id), amount: share.author },
          { account: 'sys:revenue', amount: share.commission },
        ],
      });
      db.prepare(
        `INSERT INTO tips (id, sender_id, author_id, route_id, amount, author_share, message, ledger_tx_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, user.id, author.id, route?.id ?? null, body.amount, share.author, message, txId, ts);
    });
    return reply.status(201).send({
      tip: { id, authorId: author.id, routeId: route?.id ?? null, amount: body.amount, authorShare: share.author, message, createdAt: ts },
    });
  });

  /** Страница автора: имя и маршруты из каталога; обезличенный аккаунт — без маршрутов. */
  app.get('/api/authors/:id', async (req) => {
    const { id } = routeParams.parse(req.params);
    const row = db.prepare('SELECT id, name, deleted_at FROM users WHERE id = ?').get(id) as any;
    if (!row) throw new HttpError(404, 'Автор не найден');
    if (row.deleted_at) return { author: { id, name: 'Удалённый автор' }, routes: [] };
    return { author: { id, name: row.name }, routes: ctx.routes.listedBy(id, req.user ?? null) };
  });

  // ---------- Вывод ----------

  const serializePayout = (r: any) => ({
    id: r.id,
    points: r.points,
    feePct: r.fee_pct,
    payoutRub: r.payout_kop / 100,
    status: r.status,
    createdAt: r.created_at,
    note: r.admin_note ?? null,
    decidedAt: r.decided_at ?? null,
  });

  app.get('/api/payouts/quote', async (req) => {
    ctx.requireUser(req);
    const { points } = z.object({ points: z.coerce.number().int().min(1).max(10_000_000) }).parse(req.query);
    const q = payoutQuote(points, ctx.pricing().payoutCommissionPct);
    return { points, feePct: q.feePct, fee: q.feeKop / 100, payoutRub: q.payoutKop / 100 };
  });

  /** Заявка на вывод (FR-024, FR-024d): баллы замораживаются, комиссия фиксируется при подаче. */
  app.post('/api/payouts', { config: { rateLimit: { max: 5, timeWindow: '1 day' } } }, async (req, reply) => {
    const user = requireSpender(ctx, req);
    const p = ctx.pricing();
    const { points } = z
      .object({ points: z.number().int('Целое число баллов').min(p.payoutMin, `Вывести можно от ${p.payoutMin} баллов`) })
      .parse(req.body);
    const q = payoutQuote(points, p.payoutCommissionPct);
    const id = randomUUID();
    tx(db, () => {
      if (db.prepare("SELECT 1 FROM payout_requests WHERE user_id = ? AND status = 'open'").get(user.id)) {
        throw new HttpError(409, 'Уже есть открытая заявка на вывод. Дождитесь решения или отзовите её.');
      }
      const h = hold(db, { userId: user.id, kind: 'payout', amount: points, refType: 'payout', refId: id });
      db.prepare(
        `INSERT INTO payout_requests (id, user_id, points, fee_pct, payout_kop, status, hold_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(id, user.id, points, q.feePct, q.payoutKop, h.id, nowIso());
    });
    req.log.info({ user: user.id, payout: id, points }, 'заявка на вывод');
    return reply.status(201).send({ payout: serializePayout(db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(id)) });
  });

  app.get('/api/payouts', async (req) => {
    const user = ctx.requireUser(req);
    const rows = db.prepare('SELECT * FROM payout_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    return { payouts: rows.map(serializePayout) };
  });

  /** Отзыв своей открытой заявки: заморозка снимается. */
  app.delete('/api/payouts/:id', async (req) => {
    const user = ctx.requireUser(req);
    const { id } = routeParams.parse(req.params);
    const row = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(id) as any;
    if (!row || row.user_id !== user.id) throw new HttpError(404, 'Заявка не найдена');
    if (row.status !== 'open') throw new HttpError(409, 'Заявка уже закрыта');
    tx(db, () => {
      release(db, row.hold_id);
      db.prepare(
        "UPDATE payout_requests SET status = 'rejected', admin_note = 'Отозвана пользователем', decided_at = ?, decided_by = ? WHERE id = ?",
      ).run(nowIso(), user.id, id);
    });
    return { payout: serializePayout(db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(id)) };
  });

  // ---------- Возвраты ----------

  /**
   * Статус возврата из API ЮKassa. Списание идемпотентно: pending → succeeded один раз, в одной
   * транзакции с проводкой «пользователь → sys:refunds» из заморозки и увеличением refunded_kop.
   */
  function applyRefundStatus(refundId: string, pr: ProviderRefund, log: FastifyBaseLogger) {
    const row = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as any;
    if (!row || row.status !== 'pending') return;
    const ts = nowIso();
    if (pr.status === 'succeeded') {
      tx(db, () => {
        const r = db.prepare("UPDATE refunds SET status = 'succeeded', updated_at = ? WHERE id = ? AND status = 'pending'").run(ts, row.id);
        if (!Number(r.changes)) return;
        const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id) as any;
        const h = row.hold_id ? getHold(db, row.hold_id) : undefined;
        const input = {
          kind: 'refund' as const,
          actorId: row.admin_id,
          refType: 'refund',
          refId: row.id,
          meta: { paymentId: row.payment_id, note: row.note },
          entries: [
            { account: userAccount(payment.user_id), amount: -row.points },
            { account: 'sys:refunds' as const, amount: row.points },
          ],
        };
        const txId = h?.status === 'active' ? capture(db, h.id, row.points, input, { close: true }) : post(db, input);
        db.prepare('UPDATE refunds SET ledger_tx_id = ? WHERE id = ?').run(txId, row.id);
        db.prepare('UPDATE payments SET refunded_kop = refunded_kop + ?, updated_at = ? WHERE id = ?').run(row.points * 100, ts, row.payment_id);
      });
      log.info({ refund: row.id, points: row.points }, 'возврат выполнен');
      return;
    }
    if (pr.status === 'canceled') {
      tx(db, () => {
        db.prepare("UPDATE refunds SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending'").run(ts, row.id);
        if (row.hold_id) release(db, row.hold_id);
      });
      log.warn({ refund: row.id }, 'ЮKassa отменила возврат');
    }
  }

  async function refund(input: { paymentId: string; points: number; note: string; adminId: string }, log: FastifyBaseLogger) {
    const gw = gateway();
    if (!gw) throw new HttpError(503, 'Платежи не подключены', 'PAYMENTS_DISABLED');
    const payment = db.prepare('SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(input.paymentId) as any;
    if (!payment) throw new HttpError(404, 'Платёж не найден');
    if (payment.status !== 'succeeded' || !payment.provider_id) throw new HttpError(409, 'Вернуть можно только успешный платёж');
    const id = randomUUID();
    tx(db, () => {
      // Остаток платежа: сумма минус выполненные и идущие возвраты.
      const pending = (
        db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM refunds WHERE payment_id = ? AND status = 'pending'").get(payment.id) as { s: number }
      ).s;
      const left = payment.points - payment.refunded_kop / 100 - pending;
      if (input.points > left) throw new HttpError(400, `По этому платежу можно вернуть не больше ${left} баллов`);
      const avail = available(db, payment.user_id);
      if (input.points > avail) {
        throw new HttpError(400, `У пользователя доступно ${avail} баллов: вернуть больше нельзя`, 'INSUFFICIENT_POINTS', {
          need: input.points,
          available: avail,
        });
      }
      const h = hold(db, { userId: payment.user_id, kind: 'refund', amount: input.points, refType: 'refund', refId: id });
      const ts = nowIso();
      db.prepare(
        `INSERT INTO refunds (id, payment_id, points, status, admin_id, note, hold_id, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(id, payment.id, input.points, input.adminId, input.note, h.id, ts, ts);
    });
    let pr: ProviderRefund;
    try {
      pr = await gw.createRefund({
        id,
        providerPaymentId: payment.provider_id,
        amountKop: input.points * 100,
        description: `Возврат за баллы сервиса «Для прогулок», ${input.points} шт.`,
        email: payment.email,
        receipt: ctx.payments().receipt,
      });
    } catch (err) {
      log.error(err, 'не удалось создать возврат');
      applyRefundStatus(id, { providerId: '', status: 'canceled' }, log);
      throw new HttpError(502, err instanceof GatewayError ? err.message : 'Не удалось создать возврат');
    }
    db.prepare('UPDATE refunds SET provider_id = ?, updated_at = ? WHERE id = ?').run(pr.providerId, nowIso(), id);
    applyRefundStatus(id, pr, log);
    return db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
  }

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
    // Возвраты, по которым не пришло уведомление.
    const gw = gateway();
    if (gw) {
      for (const r of db.prepare("SELECT * FROM refunds WHERE status = 'pending' AND provider_id IS NOT NULL").all() as any[]) {
        try {
          applyRefundStatus(r.id, await gw.getRefund(r.provider_id), log);
        } catch (err) {
          log.warn(err, 'сверка возврата не удалась');
        }
      }
    }
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
        // Отправителю премии контрагент — автор, автору — отправитель.
        counterparty:
          r.amount < 0 && meta.authorId
            ? { id: meta.authorId, name: meta.authorName ?? '' }
            : meta.counterpartyId
              ? { id: meta.counterpartyId, name: meta.counterpartyName ?? '' }
              : null,
        // Комиссия видна только получателю дохода.
        commission: r.amount > 0 && typeof meta.commission === 'number' ? meta.commission : null,
        message: r.amount > 0 && meta.message ? meta.message : null,
      };
    });
    return { items, next: rows.length > q.limit ? items[items.length - 1]!.id : null };
  });

  return { refund };
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
