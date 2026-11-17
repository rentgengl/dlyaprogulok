/**
 * API админки: все маршруты, все пользователи (роль, блокировка, лимиты, пароль) и настройки приложения.
 * Доступ — только у пользователей с ролью admin. Сами маршруты администратор правит обычным редактором:
 * ownedRoute пропускает его к любому маршруту.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './app.ts';
import { tx } from './db.ts';
import { HttpError } from './errors.ts';
import { saleDecisionMail, type Mailer } from './mail.ts';
import {
  effectiveEnv,
  isEditable,
  loadOverrides,
  maskSecret,
  SETTINGS,
  type Env,
  type Services,
} from './settings.ts';

export interface AdminContext {
  db: DatabaseSync;
  monthWindow: (nowMs: number) => { start: Date; end: Date };
  quotaOf: (userId: string) => unknown;
  summary: (row: any) => unknown;
  routeColumns: string;
  removeFiles: (names: string[]) => Promise<void>;
  hashPassword: (password: string) => Promise<string>;
  baseEnv: Env;
  reconfigure: (env: Env) => Services;
  applyServices: (s: Services) => void;
  status: () => {
    ai: { provider: string | null; model: string | null };
    tts: string | null;
    mailer: string | null;
    routeMonthlyLimit: number;
    appUrl: string;
  };
  mailer: () => Mailer | null;
  /** Полный маршрут для администратора (с содержимым платного). */
  fullRoute: (row: any, viewer: User) => unknown;
  loadRoute: (id: string) => any;
  /** Удаление или обезличивание аккаунта (research R11). */
  removeAccount: (userId: string) => Promise<'deleted' | 'anonymized'>;
}

const now = () => new Date().toISOString();
const paramsId = z.object({ id: z.string().uuid() });
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export function registerAdmin(app: FastifyInstance, ctx: AdminContext) {
  const { db } = ctx;

  const requireAdmin = (req: FastifyRequest): User => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Войдите в аккаунт');
    if (!user.isAdmin) throw new HttpError(403, 'Нужны права администратора');
    return user;
  };

  // Все запросы /api/admin/* — только администратору, даже если обработчик забудет проверку.
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/admin/') || req.url === '/api/admin') requireAdmin(req);
  });

  // ---------- Обзор ----------

  app.get('/api/admin/stats', async () => {
    const { start, end } = ctx.monthWindow(Date.now());
    const one = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as any).n as number;
    return {
      users: {
        total: one('SELECT COUNT(*) AS n FROM users'),
        verified: one('SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL'),
        blocked: one('SELECT COUNT(*) AS n FROM users WHERE blocked_at IS NOT NULL'),
        admins: one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
        newThisMonth: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', start.toISOString(), end.toISOString()),
      },
      routes: {
        total: one('SELECT COUNT(*) AS n FROM routes'),
        public: one('SELECT COUNT(*) AS n FROM routes WHERE is_public = 1'),
        generatedThisMonth: one(
          'SELECT COUNT(*) AS n FROM route_generations WHERE created_at >= ? AND created_at < ?',
          start.toISOString(),
          end.toISOString(),
        ),
      },
      points: {
        total: one('SELECT COUNT(*) AS n FROM points'),
        withStory: one('SELECT COUNT(*) AS n FROM points WHERE story IS NOT NULL'),
        narrated: one('SELECT COUNT(DISTINCT point_id) AS n FROM media WHERE is_narration = 1'),
      },
      media: {
        files: one('SELECT COUNT(*) AS n FROM media'),
        bytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM media'),
      },
      services: ctx.status(),
      monthStart: start.toISOString(),
    };
  });

  // ---------- Пользователи ----------

  const userRow = (u: any, used: number) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.role === 'admin',
    blocked: !!u.blocked_at,
    blockedAt: u.blocked_at,
    emailVerified: !!u.email_verified_at,
    routeLimit: u.route_limit ?? null,
    routeCount: u.route_count ?? 0,
    usedThisMonth: used,
    createdAt: u.created_at,
    activeSessions: u.session_count ?? 0,
  });

  const USER_COLUMNS = `u.*,
    (SELECT COUNT(*) FROM routes r WHERE r.owner_id = u.id) AS route_count,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count,
    (SELECT COUNT(*) FROM route_generations g WHERE g.user_id = u.id AND g.created_at >= ? AND g.created_at < ?) AS used`;
  const columnArgs = () => {
    const { start, end } = ctx.monthWindow(Date.now());
    return [Date.now(), start.toISOString(), end.toISOString()];
  };

  function loadUser(id: string): any {
    const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).get(...columnArgs(), id);
    if (!row) throw new HttpError(404, 'Пользователь не найден');
    return row;
  }

  app.get('/api/admin/users', async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(200).optional(),
        filter: z.enum(['all', 'admins', 'blocked', 'unverified']).default('all'),
        ...page,
      })
      .parse(req.query);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.q) {
      const like = likeOf(q.q);
      where.push(`(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.id = ?)`);
      args.push(like, like, q.q);
    }
    if (q.filter === 'admins') where.push("u.role = 'admin'");
    if (q.filter === 'blocked') where.push('u.blocked_at IS NOT NULL');
    if (q.filter === 'unverified') where.push('u.email_verified_at IS NULL');
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM users u ${sqlWhere}`).get(...args) as any).n;
    const rows = db
      .prepare(`SELECT ${USER_COLUMNS} FROM users u ${sqlWhere} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`)
      .all(...columnArgs(), ...args, q.limit, q.offset) as any[];
    return { total, users: rows.map((u) => userRow(u, u.used)) };
  });

  app.get('/api/admin/users/:id', async (req) => {
    const { id } = paramsId.parse(req.params);
    const u = loadUser(id);
    const routes = db
      .prepare(`SELECT ${ctx.routeColumns} FROM routes r JOIN users u ON u.id = r.owner_id WHERE r.owner_id = ? ORDER BY r.created_at DESC`)
      .all(id) as any[];
    return { user: { ...userRow(u, u.used), quota: ctx.quotaOf(id) }, routes: routes.map(ctx.summary) };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        email: z.string().trim().toLowerCase().email().max(200).optional(),
        emailVerified: z.boolean().optional(),
        isAdmin: z.boolean().optional(),
        blocked: z.boolean().optional(),
        /** null — общий лимит из настроек, 0 — без ограничения. */
        routeLimit: z.number().int().min(0).max(100_000).nullable().optional(),
        password: z.string().min(8, 'Пароль — не короче 8 символов').max(200).optional(),
      })
      .parse(req.body);
    const u = loadUser(id);
    if (id === me.id && (body.isAdmin === false || body.blocked === true)) {
      throw new HttpError(409, 'Нельзя снять права или заблокировать самого себя: попросите другого администратора');
    }
    const hash = body.password ? await ctx.hashPassword(body.password) : null;
    try {
      tx(db, () => {
        const set = (col: string, value: unknown) => db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(value as any, id);
        if (body.name !== undefined) set('name', body.name);
        if (body.email !== undefined && body.email !== u.email) set('email', body.email);
        if (body.emailVerified !== undefined) set('email_verified_at', body.emailVerified ? (u.email_verified_at ?? now()) : null);
        if (body.isAdmin !== undefined) set('role', body.isAdmin ? 'admin' : 'user');
        if (body.routeLimit !== undefined) set('route_limit', body.routeLimit);
        if (body.blocked !== undefined) {
          set('blocked_at', body.blocked ? (u.blocked_at ?? now()) : null);
          // Заблокированный выходит со всех устройств сразу.
          if (body.blocked) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        }
        if (hash) {
          set('password_hash', hash);
          // Новый пароль — старые сессии больше не действуют, кроме сессии самого администратора.
          if (id !== me.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        }
      });
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Этот email уже занят другим пользователем');
      throw err;
    }
    req.log.info({ admin: me.id, user: id, fields: Object.keys(body).filter((k) => k !== 'password').concat(hash ? ['password'] : []) }, 'админ изменил пользователя');
    const fresh = loadUser(id);
    return { user: { ...userRow(fresh, fresh.used), quota: ctx.quotaOf(id) } };
  });

  /** Обнулить счётчик созданных в этом месяце маршрутов. */
  app.post('/api/admin/users/:id/quota-reset', async (req) => {
    const { id } = paramsId.parse(req.params);
    loadUser(id);
    const { start, end } = ctx.monthWindow(Date.now());
    db.prepare('DELETE FROM route_generations WHERE user_id = ? AND created_at >= ? AND created_at < ?').run(
      id,
      start.toISOString(),
      end.toISOString(),
    );
    const fresh = loadUser(id);
    return { user: { ...userRow(fresh, fresh.used), quota: ctx.quotaOf(id) } };
  });

  app.post('/api/admin/users/:id/logout', async (req) => {
    const { id } = paramsId.parse(req.params);
    loadUser(id);
    const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { closed: Number(changes) };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req);
    const { id } = paramsId.parse(req.params);
    if (id === me.id) throw new HttpError(409, 'Нельзя удалить свой аккаунт из админки');
    loadUser(id);
    // Проданные маршруты остаются у покупателей: такой аккаунт обезличивается.
    const result = await ctx.removeAccount(id);
    req.log.info({ admin: me.id, user: id, result }, 'админ удалил пользователя');
    return reply.status(204).send();
  });

  // ---------- Платные маршруты: проверка ----------

  app.get('/api/admin/paid-routes', async (req) => {
    const admin = requireAdmin(req);
    const { status } = z
      .object({ status: z.enum(['pending', 'approved', 'rejected', 'delisted']).default('pending') })
      .parse(req.query);
    const rows = db
      .prepare(
        `SELECT ${ctx.routeColumns} FROM routes r JOIN users u ON u.id = r.owner_id
         WHERE r.sale_status = ? AND r.deleted_at IS NULL ORDER BY r.updated_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`,
      )
      .all(status) as any[];
    return { routes: rows.map((r) => ctx.fullRoute(r, admin)) };
  });

  app.post('/api/admin/paid-routes/:id/decision', async (req) => {
    const admin = requireAdmin(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({ decision: z.enum(['approve', 'reject', 'delist']), note: z.string().trim().max(1000).optional() })
      .refine((b) => b.decision === 'approve' || !!b.note, { message: 'Укажите причину' })
      .parse(req.body);
    const row = ctx.loadRoute(id);
    if (!row || row.deleted_at || !row.sale_status) throw new HttpError(404, 'Заявка не найдена');
    const allowed = { approve: ['pending', 'delisted'], reject: ['pending'], delist: ['approved'] }[body.decision];
    if (!allowed.includes(row.sale_status)) throw new HttpError(409, 'Это решение для маршрута в таком статусе недоступно');
    const ts = now();
    const note = body.note || null;
    if (body.decision === 'approve') {
      // Одобрение публикует маршрут, даже если он был приватным (FR-012a).
      db.prepare(
        "UPDATE routes SET sale_status = 'approved', sale_note = NULL, is_public = 1, sale_decided_at = ?, sale_decided_by = ? WHERE id = ?",
      ).run(ts, admin.id, id);
    } else if (body.decision === 'reject') {
      db.prepare(
        "UPDATE routes SET sale_status = 'rejected', sale_note = ?, price = NULL, is_public = 0, sale_decided_at = ?, sale_decided_by = ? WHERE id = ?",
      ).run(note, ts, admin.id, id);
    } else {
      db.prepare("UPDATE routes SET sale_status = 'delisted', sale_note = ?, sale_decided_at = ?, sale_decided_by = ? WHERE id = ?").run(
        note,
        ts,
        admin.id,
        id,
      );
    }
    req.log.info({ admin: admin.id, route: id, decision: body.decision }, 'решение по платному маршруту');
    const author = db.prepare('SELECT email, name, deleted_at FROM users WHERE id = ?').get(row.owner_id) as any;
    const mailer = ctx.mailer();
    if (mailer && author && !author.deleted_at) {
      const link = `${ctx.status().appUrl}/route/${id}`;
      await mailer
        .send(saleDecisionMail(author.email, author.name, row.title, body.decision, note, link))
        .catch((err) => req.log.error(err, 'не удалось отправить письмо о решении'));
    }
    return { route: ctx.fullRoute(ctx.loadRoute(id), admin) };
  });

  // ---------- Маршруты ----------

  app.get('/api/admin/routes', async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(200).optional(),
        owner: z.string().uuid().optional(),
        visibility: z.enum(['all', 'public', 'private']).default('all'),
        sort: z.enum(['new', 'old', 'rating']).default('new'),
        ...page,
      })
      .parse(req.query);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.q) {
      const like = likeOf(q.q);
      where.push(
        `(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.start_label LIKE ? ESCAPE '\\'
          OR r.city LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR r.id = ?)`,
      );
      args.push(like, like, like, like, like, like, q.q);
    }
    if (q.owner) {
      where.push('r.owner_id = ?');
      args.push(q.owner);
    }
    if (q.visibility === 'public') where.push('r.is_public = 1');
    if (q.visibility === 'private') where.push('r.is_public = 0');
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      q.sort === 'old' ? 'r.created_at ASC' : q.sort === 'rating' ? 'rating_avg IS NULL, rating_avg DESC, rating_count DESC' : 'r.created_at DESC';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM routes r JOIN users u ON u.id = r.owner_id ${sqlWhere}`).get(...args) as any).n;
    const rows = db
      .prepare(
        `SELECT ${ctx.routeColumns}, u.email AS owner_email FROM routes r JOIN users u ON u.id = r.owner_id
         ${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, q.limit, q.offset) as any[];
    return { total, routes: rows.map((r) => ({ ...(ctx.summary(r) as object), ownerEmail: r.owner_email, updatedAt: r.updated_at })) };
  });

  app.patch('/api/admin/routes/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(1000).optional(),
        isPublic: z.boolean().optional(),
        storyStyle: z.enum(['facts', 'legends']).optional(),
        city: z.string().trim().max(120).optional(),
        /** Передать маршрут другому пользователю: по id или email. */
        owner: z.string().trim().min(1).max(200).optional(),
      })
      .parse(req.body);
    const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as any;
    if (!row) throw new HttpError(404, 'Маршрут не найден');
    let ownerId: string | null = null;
    if (body.owner) {
      const owner = db.prepare('SELECT id FROM users WHERE id = ? OR lower(email) = lower(?)').get(body.owner, body.owner) as any;
      if (!owner) throw new HttpError(404, `Пользователь «${body.owner}» не найден`);
      ownerId = owner.id;
    }
    tx(db, () => {
      const set = (col: string, value: unknown) => db.prepare(`UPDATE routes SET ${col} = ? WHERE id = ?`).run(value as any, id);
      if (body.title !== undefined) set('title', body.title);
      if (body.description !== undefined) set('description', body.description);
      if (body.isPublic !== undefined) set('is_public', body.isPublic ? 1 : 0);
      if (body.storyStyle !== undefined) set('story_style', body.storyStyle);
      if (body.city !== undefined) set('city', body.city);
      if (ownerId && ownerId !== row.owner_id) {
        set('owner_id', ownerId);
        // Своему маршруту оценку не ставят: оценка нового владельца удаляется.
        db.prepare('DELETE FROM ratings WHERE route_id = ? AND user_id = ?').run(id, ownerId);
      }
      set('updated_at', now());
    });
    req.log.info({ admin: me.id, route: id, fields: Object.keys(body) }, 'админ изменил маршрут');
    const fresh = db
      .prepare(`SELECT ${ctx.routeColumns}, u.email AS owner_email FROM routes r JOIN users u ON u.id = r.owner_id WHERE r.id = ?`)
      .get(id) as any;
    return { route: { ...(ctx.summary(fresh) as object), ownerEmail: fresh.owner_email, updatedAt: fresh.updated_at } };
  });

  // Удаление маршрута — общим DELETE /api/routes/:id: администратору он разрешён.

  // ---------- Настройки ----------

  function settingsView() {
    const overrides = loadOverrides(db);
    const meta = new Map(
      (db.prepare('SELECT key, updated_at, updated_by FROM settings').all() as any[]).map((r) => [r.key, r]),
    );
    const users = new Map(
      (db.prepare('SELECT id, email FROM users WHERE id IN (SELECT updated_by FROM settings)').all() as any[]).map((u) => [u.id, u.email]),
    );
    return SETTINGS.map((d) => {
      const fromAdmin = d.editable && d.key in overrides;
      const value = fromAdmin ? overrides[d.key] : ctx.baseEnv[d.key];
      const m = meta.get(d.key);
      return {
        ...d,
        source: fromAdmin ? 'admin' : value !== undefined && value !== '' ? 'env' : 'default',
        value: d.kind === 'secret' ? null : (value ?? ''),
        isSet: !!value,
        masked: d.kind === 'secret' ? maskSecret(value) : null,
        envValue: d.kind === 'secret' ? maskSecret(ctx.baseEnv[d.key]) : (ctx.baseEnv[d.key] ?? null),
        updatedAt: fromAdmin ? (m?.updated_at ?? null) : null,
        updatedBy: fromAdmin && m?.updated_by ? (users.get(m.updated_by) ?? null) : null,
      };
    });
  }

  app.get('/api/admin/settings', async () => ({ settings: settingsView(), services: ctx.status() }));

  /**
   * values: ключ → новое значение; null — убрать правку и вернуть значение из .env.
   * Перед сохранением сервисы собираются с новыми настройками: ошибка — ничего не меняется.
   */
  app.put('/api/admin/settings', async (req) => {
    const me = requireAdmin(req);
    const { values } = z
      .object({ values: z.record(z.string(), z.string().max(4000).nullable()) })
      .parse(req.body);
    for (const key of Object.keys(values)) {
      if (!isEditable(key)) throw new HttpError(400, `Настройку ${key} нельзя менять из админки`);
    }
    const next = { ...loadOverrides(db) };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete next[key];
      else next[key] = value.trim();
    }
    let services: Services;
    try {
      services = ctx.reconfigure(effectiveEnv(ctx.baseEnv, next));
    } catch (err: any) {
      throw new HttpError(400, `Настройки не применены: ${err?.message ?? err}`);
    }
    tx(db, () => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        else
          db.prepare(
            `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          ).run(key, value.trim(), now(), me.id);
      }
    });
    ctx.applyServices(services);
    req.log.info({ admin: me.id, keys: Object.keys(values) }, 'админ изменил настройки');
    return { settings: settingsView(), services: ctx.status() };
  });

  /** Пробное письмо администратору: проверить SMTP после смены настроек. */
  app.post('/api/admin/settings/test-mail', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const me = requireAdmin(req);
    const mailer = ctx.mailer();
    if (!mailer) throw new HttpError(409, 'Почта не настроена: задайте SMTP-сервер');
    try {
      await mailer.send({
        to: me.email,
        subject: 'Проверка почты «Для прогулок»',
        text: `Это пробное письмо из админки. Если вы его читаете, отправка работает.\n\n${randomUUID()}`,
        html: '<p>Это пробное письмо из админки. Если вы его читаете, отправка работает.</p>',
      });
    } catch (err: any) {
      throw new HttpError(502, `Письмо не отправлено: ${err?.message ?? err}`);
    }
    return { sentTo: me.email };
  });
}
