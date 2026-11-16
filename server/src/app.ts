import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { copyFile, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { stripNoLegendsNote, type AI } from './ai.ts';
import { registerAdmin } from './admin.ts';
import { tx } from './db.ts';
import { HttpError } from './errors.ts';
import { createJobRunner, serializeJob, type JobControl, type JobRow } from './jobs.ts';
import { contentDisposition, toGpx, toKml } from './export.ts';
import { bestInsertion, centroid, computeBudget, estimateDurationMin, haversine, orderStops, type LatLng } from './geo.ts';
import { NoCandidatesError, planRoute, rankCandidates } from './planner.ts';
import { passwordResetMail, verificationMail, type Mailer } from './mail.ts';
import { factsSource, factsStory, mergeFacts, type Fact, type PlacePhoto } from './places.ts';
import { legendSections, normalize, type GeoServices } from './services.ts';
import { injectShareMeta, routeFacts } from './share.ts';
import { capture, findHold, hold, release, userAccount } from './ledger.ts';
import { checkExpected, registerMoney, requireSpender, walletBrief, type MoneyContext } from './money.ts';
import {
  narrationCost,
  quoteTotal,
  routeCost,
  routeMinutes,
  storyItemQuote,
  type Pricing,
  type StoryQuoteItem,
} from './pricing.ts';
import { paymentsFromEnv, pricingFromEnv, servicesFromEnv, type Env, type PaymentsConfig, type Services } from './settings.ts';
import { mp3DurationSec, type TTS } from './tts.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const here = path.dirname(fileURLToPath(import.meta.url));

const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MEDIA_PER_POINT = 20;
const MAX_POINTS = 30;
/** Сколько маршрутов один пользователь может строить в фоне одновременно. */
const MAX_ACTIVE_JOBS = 3;
/** Рассказ без ИИ — начало статьи такой длины; примерно как рассказ ИИ на 250–450 слов. */
const STORY_FALLBACK_CHARS = 2400;
/** Текст рассказа, который можно сохранить вручную. */
const MAX_STORY_CHARS = 8000;
/**
 * Формат рассказов ИИ. Готовые рассказы старого формата (вдвое короче, по одному источнику)
 * не переиспользуются в новых маршрутах: для места пишется новый.
 */
const STORY_VERSION = 2;
/** Своя статья короче этого — к ней добавляется статья на другом языке. */
const SHORT_ARTICLE_CHARS = 4000;
/** Дальше от старта — уже не пешая прогулка, а скорее ошибка в координатах. */
const MAX_POINT_DISTANCE_M = 25_000;
const MB = 1024 * 1024;

/** Только форматы без активного содержимого: SVG и HTML сюда нельзя, файлы отдаются всем. */
const MEDIA_TYPES: Record<string, { kind: 'image' | 'audio' | 'video'; ext: string; maxBytes: number }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg', maxBytes: 15 * MB },
  'image/png': { kind: 'image', ext: 'png', maxBytes: 15 * MB },
  'image/webp': { kind: 'image', ext: 'webp', maxBytes: 15 * MB },
  'audio/mpeg': { kind: 'audio', ext: 'mp3', maxBytes: 50 * MB },
  'audio/mp3': { kind: 'audio', ext: 'mp3', maxBytes: 50 * MB },
  'audio/mp4': { kind: 'audio', ext: 'm4a', maxBytes: 50 * MB },
  'audio/x-m4a': { kind: 'audio', ext: 'm4a', maxBytes: 50 * MB },
  'audio/aac': { kind: 'audio', ext: 'aac', maxBytes: 50 * MB },
  'audio/ogg': { kind: 'audio', ext: 'ogg', maxBytes: 50 * MB },
  'audio/wav': { kind: 'audio', ext: 'wav', maxBytes: 50 * MB },
  'audio/x-wav': { kind: 'audio', ext: 'wav', maxBytes: 50 * MB },
  'video/mp4': { kind: 'video', ext: 'mp4', maxBytes: 200 * MB },
  'video/quicktime': { kind: 'video', ext: 'mov', maxBytes: 200 * MB },
  'video/webm': { kind: 'video', ext: 'webm', maxBytes: 200 * MB },
};
const MAX_UPLOAD_BYTES = 200 * MB;

export interface AppDeps {
  db: DatabaseSync;
  geo: GeoServices;
  ai: AI | null;
  tts: TTS | null;
  uploadsDir: string;
  tiles?: { url: string; attribution: string };
  /** true, только если сервер слушает localhost за своим прокси: иначе клиент подделает свой IP. */
  trustProxy?: boolean;
  /** Почта для подтверждения адреса. Без неё подтверждение не требуется. */
  mailer?: Mailer | null;
  /** Адрес веб-версии: из него строятся ссылки в письмах. */
  appUrl?: string;
  /** Сколько маршрутов пользователь может создать за календарный месяц; 0 — без ограничения. */
  routeMonthlyLimit?: number;
  /** index.html веб-версии: в него для ссылок на маршрут подставляются превью для мессенджеров. */
  webIndexPath?: string;
  /** Адреса, которые получают права администратора (ADMIN_EMAILS). */
  adminEmails?: string[];
  /** Значения из .env: поверх них ложатся правки настроек из админки. */
  baseEnv?: Env;
  /** Сборка ИИ, озвучки и почты из настроек; в тестах подменяется. */
  reconfigure?: (env: Env) => Services;
  aiInfo?: { provider: string | null; model: string | null };
  /** Цены платных действий; по умолчанию — значения из спецификации. */
  pricing?: Pricing;
  /** Платёжный шлюз; без него платные функции выключены и сервис работает как раньше. */
  payments?: PaymentsConfig;
}


export interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isAdmin: boolean;
}

const toUser = (row: any): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  emailVerified: !!row.email_verified_at,
  isAdmin: row.role === 'admin',
});

/** Москва живёт по UTC+3 без перехода на летнее время: месяц для лимита считается по ней. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export function monthWindow(nowMs: number): { start: Date; end: Date } {
  const msk = new Date(nowMs + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - MSK_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - MSK_OFFSET_MS),
  };
}

const RU_MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «1 декабря» по московскому времени. */
const ruDate = (d: Date) => {
  const msk = new Date(d.getTime() + MSK_OFFSET_MS);
  return `${msk.getUTCDate()} ${RU_MONTHS_GENITIVE[msk.getUTCMonth()]}`;
};

const EMAIL_TOKEN_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_MS = 60 * 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':');
  const expected = Buffer.from(key!, 'hex');
  const actual = await scrypt(password, Buffer.from(salt!, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Хэш от случайного пароля: вход с несуществующим email занимает столько же времени. */
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

const requireUser = (req: FastifyRequest): User => {
  if (!req.user) throw new HttpError(401, 'Войдите в аккаунт');
  return req.user;
};

const parseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const langSchema = z.enum(['ru', 'en', 'de', 'fr', 'es', 'it']).default('ru');
const storyStyleSchema = z.enum(['facts', 'legends']);
const latLng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

const generateSchema = z
  .object({
    start: z.object({ ...latLng, label: z.string().trim().max(200).optional() }),
    durationMin: z.number().min(15).max(480).optional(),
    distanceM: z.number().min(300).max(30_000).optional(),
    roundTrip: z.boolean().default(true),
    interests: z.string().trim().max(300).optional(),
    storyStyle: storyStyleSchema.default('facts'),
    lang: langSchema,
    /** true — подбор в фоновой задаче: ответ 202 с задачей сразу. */
    background: z.boolean().default(false),
    /** Для фоновой задачи: сразу создать рассказы и озвучку для всех точек. */
    autoStories: z.boolean().default(false),
    /** Цена, которую пользователь видел и подтвердил (для подбора сверх бесплатного лимита). */
    expectedCost: z.number().int().min(0).optional(),
  })
  .refine((v) => (v.durationMin === undefined) !== (v.distanceM === undefined), {
    message: 'Укажите либо длительность, либо длину маршрута',
  });

/** Маршрут вручную: название и старт, точки автор добавляет сам. */
const manualSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(120),
  description: z.string().trim().max(1000).default(''),
  start: z.object({ ...latLng, label: z.string().trim().max(200).optional() }),
  roundTrip: z.boolean().default(true),
  storyStyle: storyStyleSchema.default('facts'),
  lang: langSchema,
});

const credentials = {
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
};

const paramsId = z.object({ id: z.string().uuid() });
const latLngQuery = {
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, geo, uploadsDir } = deps;
  // Зависят от настроек: админка пересобирает их на лету (applyServices).
  let ai = deps.ai;
  let tts = deps.tts;
  let mailer = deps.mailer ?? null;
  let appUrl = (deps.appUrl ?? 'http://localhost:8081').replace(/\/+$/, '');
  let monthlyLimit = deps.routeMonthlyLimit ?? 5;
  let tiles = deps.tiles;
  let aiInfo = deps.aiInfo ?? { provider: ai ? 'custom' : null, model: null };
  let pricing = deps.pricing ?? pricingFromEnv({});
  let payments = deps.payments ?? paymentsFromEnv({});
  const applyServices = (s: Services) => {
    ai = s.ai;
    tts = s.tts;
    mailer = s.mailer;
    appUrl = (s.appUrl ?? 'http://localhost:8081').replace(/\/+$/, '');
    monthlyLimit = s.routeMonthlyLimit;
    tiles = s.tiles;
    aiInfo = { provider: s.aiProvider, model: s.aiModel };
    pricing = s.pricing;
    payments = s.payments;
  };
  const adminEmails = (deps.adminEmails ?? []).map((e) => e.toLowerCase());
  if (adminEmails.length) {
    db.prepare(
      `UPDATE users SET role = 'admin' WHERE lower(email) IN (${adminEmails.map(() => '?').join(', ')})`,
    ).run(...adminEmails);
  }
  mkdirSync(uploadsDir, { recursive: true });

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && !process.env.QUIET,
    // За обратным прокси (Caddy) адрес клиента приходит в X-Forwarded-For. Без этого все пользователи
    // выглядели бы как 127.0.0.1 и делили бы одни лимиты запросов на всех.
    trustProxy: deps.trustProxy ?? false,
  });

  // Токен передаётся в заголовке, cookie нет, поэтому открытый CORS не даёт чужим сайтам доступа к сессии.
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Без этого браузер прячет от приложения имя скачиваемого файла.
    exposedHeaders: ['Content-Disposition'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  await app.register(fastifyStatic, {
    root: path.resolve(uploadsDir),
    prefix: '/media/',
    setHeaders(res) {
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('Content-Security-Policy', "default-src 'none'; sandbox");
      res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });
  await app.register(fastifyStatic, {
    root: path.join(here, '..', 'public'),
    prefix: '/map/',
    decorateReply: false,
    setHeaders(res) {
      // tile.openstreetmap.org блокирует запросы без Referer.
      res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    },
  });
  await app.register(fastifyStatic, {
    root: path.join(here, '..', 'node_modules', 'leaflet', 'dist'),
    prefix: '/map/leaflet/',
    decorateReply: false,
  });

  app.decorateRequest('user', null);
  const findSession = db.prepare(
    `SELECT u.id, u.email, u.name, u.email_verified_at, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.blocked_at IS NULL`,
  );
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const row = findSession.get(sha256(header.slice(7)), Date.now());
      req.user = row ? toUser(row) : null;
    }
  });

  /** Создание маршрутов, публикация и оценки — только с подтверждённой почтой, если почта подключена. */
  const requireVerified = (req: FastifyRequest): User => {
    const user = requireUser(req);
    if (mailer && !user.emailVerified) {
      throw new HttpError(
        403,
        `Подтвердите почту: ссылка в письме, отправленном на ${user.email}. Письмо можно отправить ещё раз в профиле.`,
        'EMAIL_NOT_VERIFIED',
      );
    }
    return user;
  };

  const moneyCtx: MoneyContext = {
    db,
    requireUser,
    requireVerified,
    monthWindow,
    pricing: () => pricing,
    payments: () => payments,
    mailer: () => mailer,
    appUrl: () => appUrl,
    log: app.log,
  };
  /** Платные действия включены, только когда подключён платёжный шлюз; иначе всё как до монетизации. */
  const charging = () => !!payments.provider;

  /** Списание из резерва за готовый результат: проводка «пользователь → выручка». */
  function captureCharge(
    holdId: string,
    userId: string,
    amount: number,
    ref: { type: string; id: string },
    meta: { title: string; routeId?: string; routeTitle?: string },
    close = false,
  ) {
    tx(db, () =>
      capture(
        db,
        holdId,
        amount,
        {
          kind: 'charge',
          actorId: userId,
          refType: ref.type,
          refId: ref.id,
          meta,
          entries: [
            { account: userAccount(userId), amount: -amount },
            { account: 'sys:revenue', amount },
          ],
        },
        { close },
      ),
    );
  }

  /** Свой лимит пользователя, иначе общий; 0 — без ограничения. */
  function limitOf(userId: string): number {
    const row = db.prepare('SELECT route_limit FROM users WHERE id = ?').get(userId) as any;
    return row?.route_limit ?? monthlyLimit;
  }

  function quotaOf(userId: string) {
    const monthlyLimit = limitOf(userId);
    const { start, end } = monthWindow(Date.now());
    let used = (
      db
        .prepare('SELECT COUNT(*) AS n FROM route_generations WHERE user_id = ? AND created_at >= ? AND created_at < ?')
        .get(userId, start.toISOString(), end.toISOString()) as any
    ).n as number;
    // Маршруты, которые ещё подбираются в фоне, уже занимают место в лимите.
    const pending = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND kind = 'generate' AND status IN ('queued', 'running') AND route_id IS NULL",
        )
        .get(userId) as any
    ).n as number;
    used += pending;
    return {
      limit: monthlyLimit || null,
      used,
      remaining: monthlyLimit ? Math.max(0, monthlyLimit - used) : null,
      resetsAt: end.toISOString(),
    };
  }

  const publicUser = (user: User) => ({ ...user, quota: quotaOf(user.id), wallet: walletBrief(db, user.id) });

  async function sendVerification(user: { id: string; email: string; name: string }, log: FastifyRequest['log']) {
    if (!mailer) return;
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND expires_at < ?').run(user.id, Date.now());
    db.prepare('INSERT INTO email_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      sha256(token),
      user.id,
      Date.now() + EMAIL_TOKEN_MS,
      now(),
    );
    try {
      await mailer.send(verificationMail(user.email, user.name, `${appUrl}/verify?token=${token}`));
    } catch (err) {
      log.error(err);
      throw new HttpError(502, 'Не удалось отправить письмо. Попробуйте ещё раз через несколько минут.');
    }
  }

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues[0]?.message ?? 'Некорректный запрос' });
    }
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ ...err.extra, error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Слишком много запросов, подождите немного' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'Файл слишком большой' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  // ---------- Сериализация ----------

  const ROUTE_COLUMNS = `r.*, u.name AS owner_name,
    (SELECT COUNT(*) FROM ratings x WHERE x.route_id = r.id) AS rating_count,
    (SELECT AVG(x.value) FROM ratings x WHERE x.route_id = r.id) AS rating_avg,
    (SELECT COUNT(*) FROM points p WHERE p.route_id = r.id) AS point_count`;

  const summary = (r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    lang: r.lang,
    isPublic: !!r.is_public,
    roundTrip: !!r.round_trip,
    start: { lat: r.start_lat, lng: r.start_lng, label: r.start_label },
    distanceM: r.distance_m,
    durationMin: r.duration_min,
    planner: r.planner,
    city: r.city || null,
    storyStyle: r.story_style ?? 'facts',
    finish: r.end_lat === null || r.end_lat === undefined ? null : { lat: r.end_lat, lng: r.end_lng, label: r.end_label },
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    pointCount: r.point_count,
    rating: { avg: r.rating_avg === null ? null : Math.round(r.rating_avg * 10) / 10, count: r.rating_count },
    createdAt: r.created_at,
  });

  const serializeMedia = (m: any) => ({
    id: m.id,
    kind: m.kind,
    url: `/media/${m.file_name}`,
    mime: m.mime,
    size: m.size,
    caption: m.caption,
  });

  function loadRouteRow(id: string): any {
    return db
      .prepare(`SELECT ${ROUTE_COLUMNS} FROM routes r JOIN users u ON u.id = r.owner_id WHERE r.id = ?`)
      .get(id);
  }

  /** Задача для клиента: с режимом оплаты, списанным и зарезервированным. */
  function jobView(row: JobRow) {
    const params = JSON.parse(row.params) as { billing?: 'free' | 'paid' };
    const charged = (
      db
        .prepare(
          `SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
           WHERE t.ref_type = 'job' AND t.ref_id = ? AND e.account = 'sys:revenue'`,
        )
        .get(row.id) as { s: number }
    ).s;
    return { ...serializeJob(row), billing: params.billing ?? 'free', charged, reserved: findHold(db, 'job', row.id)?.amount ?? 0 };
  }

  /** Задача по маршруту: идущая или закончившаяся за последние 15 минут. */
  function routeJob(routeId: string) {
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE route_id = ? AND (status IN ('queued', 'running') OR updated_at > ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(routeId, new Date(Date.now() - 15 * 60_000).toISOString()) as JobRow | undefined;
    return row ? jobView(row) : null;
  }

  function fullRoute(row: any, viewer: User | null) {
    const points = db.prepare('SELECT * FROM points WHERE route_id = ? ORDER BY position').all(row.id) as any[];
    const media = db
      .prepare(
        `SELECT m.* FROM media m JOIN points p ON p.id = m.point_id WHERE p.route_id = ? ORDER BY m.created_at`,
      )
      .all(row.id) as any[];
    const mine = viewer
      ? (db.prepare('SELECT value FROM ratings WHERE route_id = ? AND user_id = ?').get(row.id, viewer.id) as any)
      : null;
    return {
      ...summary(row),
      geometry: JSON.parse(row.geometry),
      myRating: mine?.value ?? null,
      isOwner: viewer?.id === row.owner_id,
      // Администратор правит любой маршрут тем же редактором.
      canEdit: viewer?.id === row.owner_id || !!viewer?.isAdmin,
      // Фоновая задача по маршруту: идущая или закончившаяся недавно (чтобы показать итог).
      job: viewer?.id === row.owner_id || viewer?.isAdmin ? routeJob(row.id) : null,
      points: points.map((p) => {
        const own = media.filter((m) => m.point_id === p.id);
        const narration = own.find((m) => m.is_narration);
        return {
          id: p.id,
          position: p.position,
          name: p.name,
          kind: p.kind,
          lat: p.lat,
          lng: p.lng,
          teaser: p.teaser,
          story: p.story,
          storySource: p.story_source,
          storySourceUrl: p.story_source_url,
          // Рассказы до появления выбора были фактическими.
          storyStyle: p.story_style ?? (p.story && p.story_source !== 'author' ? 'facts' : null),
          narrationUrl: narration ? `/media/${narration.file_name}` : null,
          media: own.filter((m) => !m.is_narration).map(serializeMedia),
          photo: parseJson<PlacePhoto>(p.photo),
          wikidata: p.wikidata ?? null,
          heritageRef: p.heritage_ref ?? null,
        };
      }),
    };
  }

  /** Чужие приватные маршруты неотличимы от несуществующих. */
  function visibleRoute(id: string, viewer: User | null): any {
    const row = loadRouteRow(id);
    if (!row || (!row.is_public && row.owner_id !== viewer?.id && !viewer?.isAdmin)) throw new HttpError(404, 'Маршрут не найден');
    return row;
  }

  function ownedRoute(id: string, user: User): any {
    const row = visibleRoute(id, user);
    if (row.owner_id !== user.id && !user.isAdmin) throw new HttpError(403, 'Изменять маршрут может только автор');
    return row;
  }

  function ownedPoint(id: string, user: User): any {
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(id) as any;
    if (!point) throw new HttpError(404, 'Точка не найдена');
    return { point, route: ownedRoute(point.route_id, user) };
  }

  async function removeFiles(names: string[]) {
    await Promise.all(names.map((n) => unlink(path.join(uploadsDir, n)).catch(() => {})));
  }

  function touchRoute(id: string) {
    db.prepare('UPDATE routes SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  async function dropNarration(pointId: string) {
    const old = db.prepare('SELECT id, file_name FROM media WHERE point_id = ? AND is_narration = 1').all(pointId) as any[];
    db.prepare('DELETE FROM media WHERE point_id = ? AND is_narration = 1').run(pointId);
    await removeFiles(old.map((m) => m.file_name));
  }

  /** Новый порядок точек: позиции, путь по улицам, длина и время пересчитываются вместе. */
  async function rebuildPath(route: any, ordered: any[], extra?: () => void) {
    const start = { lat: route.start_lat, lng: route.start_lng };
    const finish = finishOf(route);
    // Свой финиш — последняя вершина пути; маршрут тогда не кольцевой.
    const walk = await geo.walkPath(start, finish ? [...ordered, finish] : ordered, finish ? false : !!route.round_trip);
    tx(db, () => {
      extra?.();
      const reposition = db.prepare('UPDATE points SET position = ? WHERE id = ?');
      ordered.forEach((p, i) => reposition.run(i, p.id));
      db.prepare('UPDATE routes SET distance_m = ?, duration_min = ?, geometry = ?, updated_at = ? WHERE id = ?').run(
        walk.distanceM,
        estimateDurationMin(walk.distanceM, ordered.length),
        JSON.stringify(walk.geometry),
        now(),
        route.id,
      );
    });
  }

  const finishOf = (route: any): LatLng | null =>
    route.end_lat === null || route.end_lat === undefined ? null : { lat: route.end_lat, lng: route.end_lng };

  const routePoints = (routeId: string) =>
    db.prepare('SELECT * FROM points WHERE route_id = ? ORDER BY position').all(routeId) as any[];

  interface NewPoint {
    id: string;
    routeId: string;
    position: number;
    name: string;
    kind: string;
    lat: number;
    lng: number;
    teaser: string;
    wikiTitle: string | null;
    wikidata?: string | null;
    osmId?: string | null;
    heritageRef?: string | null;
    facts?: Fact[] | null;
    photo?: PlacePhoto | null;
  }

  function insertPoint(p: NewPoint) {
    db.prepare(
      `INSERT INTO points (id, route_id, position, name, kind, lat, lng, teaser, wiki_title, wikidata, osm_id, heritage_ref, facts, photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.routeId,
      p.position,
      p.name,
      p.kind,
      p.lat,
      p.lng,
      p.teaser,
      p.wikiTitle,
      p.wikidata ?? null,
      p.osmId ?? null,
      p.heritageRef ?? null,
      p.facts?.length ? JSON.stringify(p.facts) : null,
      p.photo ? JSON.stringify(p.photo) : null,
    );
  }

  /** Фото — украшение: если Commons не ответил, маршрут создаётся без них. */
  async function lookupPhotos(
    places: { wikiTitle?: string | null; wikidata?: string | null; commonsFile?: string | null }[],
    lang: string,
    log: FastifyRequest['log'],
  ) {
    try {
      return await geo.placePhotos(places, lang);
    } catch (err) {
      log.warn(err);
      return places.map((p) => ({ wikidata: p.wikidata ?? null, photo: null }));
    }
  }

  // ---------- Общее ----------

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => ({
    aiEnabled: !!ai,
    ttsEnabled: !!tts,
    emailVerification: !!mailer,
    routeMonthlyLimit: monthlyLimit || null,
    tiles: tiles ?? {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  }));

  app.get(
    '/api/geocode',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { q, lang, lat, lng } = z
        .object({
          q: z.string().trim().min(2).max(200),
          lang: langSchema,
          lat: z.coerce.number().min(-90).max(90).optional(),
          lng: z.coerce.number().min(-180).max(180).optional(),
        })
        .parse(req.query);
      const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
      try {
        return { results: await geo.geocode(q, lang, near) };
      } catch (err) {
        req.log.warn(err);
        throw new HttpError(502, 'Поиск адреса сейчас недоступен');
      }
    },
  );

  // ---------- Города ----------

  /** Города, где уже есть открытые экскурсии: с них удобно начать выбор. */
  app.get('/api/cities', async () => {
    const rows = db
      .prepare(
        `SELECT city AS name, COUNT(*) AS count, AVG(start_lat) AS lat, AVG(start_lng) AS lng
         FROM routes WHERE is_public = 1 AND city IS NOT NULL AND city != ''
         GROUP BY city ORDER BY count DESC, city LIMIT 100`,
      )
      .all() as any[];
    return { cities: rows.map((r) => ({ name: r.name, count: r.count, lat: r.lat, lng: r.lng })) };
  });

  const cityLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/cities/search', cityLimit, async (req) => {
    const { q, lang } = z.object({ q: z.string().trim().min(2).max(100), lang: langSchema }).parse(req.query);
    try {
      return { cities: await geo.searchCities(q, lang) };
    } catch (err) {
      req.log.warn(err);
      throw new HttpError(502, 'Поиск городов сейчас недоступен');
    }
  });

  app.get('/api/cities/locate', cityLimit, async (req) => {
    const { lat, lng, lang } = z.object({ ...latLngQuery, lang: langSchema }).parse(req.query);
    let name: string | null;
    try {
      name = await geo.reverseCity({ lat, lng }, lang);
    } catch (err) {
      req.log.warn(err);
      throw new HttpError(502, 'Не удалось определить город, выберите его из списка');
    }
    if (!name) throw new HttpError(404, 'Здесь не нашлось города, выберите его из списка');
    return { city: { name, lat, lng } };
  });

  // ---------- Аккаунт ----------

  function createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token),
      userId,
      Date.now() + SESSION_MS,
    );
    return token;
  }

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const body = z
      .object({ ...credentials, name: z.string().trim().min(1).max(60) })
      .parse(req.body);
    const hash = await hashPassword(body.password);
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        body.email,
        body.name,
        hash,
        now(),
      );
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Этот email уже зарегистрирован');
      throw err;
    }
    // Без почты подтверждать нечем: адрес сразу считается подтверждённым.
    if (!mailer) db.prepare('UPDATE users SET email_verified_at = created_at WHERE id = ?').run(id);
    const isAdmin = adminEmails.includes(body.email.toLowerCase());
    if (isAdmin) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
    const user: User = { id, email: body.email, name: body.name, emailVerified: !mailer, isAdmin };
    // Письмо не ушло — аккаунт всё равно создан, отправить его можно повторно из профиля.
    let mailSent = false;
    try {
      await sendVerification(user, req.log);
      mailSent = !!mailer;
    } catch {
      mailSent = false;
    }
    return reply.status(201).send({ token: createSession(id), user: publicUser(user), mailSent });
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = z.object(credentials).parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as any;
    const ok = await checkPassword(body.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Неверный email или пароль');
    if (row.blocked_at) throw new HttpError(403, 'Аккаунт заблокирован. Напишите на info@dlyaprogulok.ru, если это ошибка.');
    return { token: createSession(row.id), user: publicUser(toUser(row)) };
  });

  /** Ссылка из письма: открыть её можно и на другом устройстве, без входа. */
  app.post('/api/auth/verify', authLimit, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    const row = db
      .prepare('SELECT user_id FROM email_tokens WHERE token_hash = ? AND expires_at > ?')
      .get(sha256(token), Date.now()) as any;
    if (!row) throw new HttpError(400, 'Ссылка недействительна или устарела. Запросите новое письмо в профиле.');
    tx(db, () => {
      db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(now(), row.user_id);
      db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(row.user_id);
    });
    const user = toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id));
    // Вошедшему пользователю отдаём профиль целиком, гостю — только факт подтверждения.
    return { verified: true, user: req.user?.id === user.id ? publicUser(user) : null };
  });

  app.post(
    '/api/auth/resend',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour', keyGenerator: (req: FastifyRequest) => req.headers.authorization ?? req.ip } } },
    async (req) => {
      const user = requireUser(req);
      if (!mailer) throw new HttpError(409, 'Подтверждение почты не требуется');
      if (user.emailVerified) return { sent: false, user: publicUser(user) };
      await sendVerification(user, req.log);
      return { sent: true, user: publicUser(user) };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(header.slice(7)));
    }
    return reply.status(204).send();
  });

  app.get('/api/me', async (req) => ({ user: publicUser(requireUser(req)) }));

  /**
   * Сброс пароля: письмо со ссылкой. Ответ одинаковый, есть такой адрес или нет,
   * чтобы по форме нельзя было узнать, кто зарегистрирован.
   */
  app.post(
    '/api/auth/forgot',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req) => {
      const { email } = z.object({ email: credentials.email }).parse(req.body);
      if (!mailer) {
        throw new HttpError(409, 'Восстановление по почте сейчас недоступно. Напишите на info@dlyaprogulok.ru.');
      }
      const row = db.prepare('SELECT * FROM users WHERE email = ? AND blocked_at IS NULL').get(email) as any;
      if (row) {
        const token = randomBytes(32).toString('base64url');
        tx(db, () => {
          db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
          db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
            sha256(token),
            row.id,
            Date.now() + RESET_TOKEN_MS,
            now(),
          );
        });
        // Сбой отправки не раскрываем: ответ должен быть таким же, как для неизвестного адреса.
        await mailer.send(passwordResetMail(row.email, row.name, `${appUrl}/reset?token=${token}`)).catch((err) => req.log.error(err));
      }
      return { sent: true };
    },
  );

  /** Новый пароль по ссылке из письма: старые сессии закрываются, пользователь сразу входит. */
  app.post('/api/auth/reset', authLimit, async (req) => {
    const body = z.object({ token: z.string().min(20).max(200), password: credentials.password }).parse(req.body);
    const reset = db
      .prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?')
      .get(sha256(body.token), Date.now()) as any;
    if (!reset) throw new HttpError(400, 'Ссылка недействительна или устарела. Запросите новое письмо.');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.user_id) as any;
    if (!row || row.blocked_at) throw new HttpError(403, 'Аккаунт заблокирован. Напишите на info@dlyaprogulok.ru, если это ошибка.');
    const hash = await hashPassword(body.password);
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(hash, now(), row.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
    });
    const user = toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
    return { token: createSession(row.id), user: publicUser(user) };
  });

  /** Удаление своего аккаунта со всеми маршрутами, оценками и файлами. Нужен пароль. */
  app.delete('/api/me', authLimit, async (req, reply) => {
    const user = requireUser(req);
    const { password } = z.object({ password: z.string().min(1, 'Введите пароль').max(200) }).parse(req.body ?? {});
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
    if (!(await checkPassword(password, row.password_hash))) throw new HttpError(403, 'Неверный пароль');
    if (user.isAdmin) {
      const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND blocked_at IS NULL").get() as any).n;
      if (admins <= 1) throw new HttpError(409, 'Вы единственный администратор: сначала передайте права другому пользователю в админке.');
    }
    const files = db
      .prepare('SELECT m.file_name FROM media m JOIN points p ON p.id = m.point_id JOIN routes r ON r.id = p.route_id WHERE r.owner_id = ?')
      .all(user.id) as any[];
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    await removeFiles(files.map((f) => f.file_name));
    req.log.info({ user: user.id }, 'пользователь удалил аккаунт');
    return reply.status(204).send();
  });

  // ---------- Маршруты ----------

  const aiKey = (req: FastifyRequest) => req.headers.authorization ?? req.ip;

  // ---------- Фоновые задачи ----------

  /** Точки, для которых задача рассказов пишет текст: без рассказа; redo — и с рассказом другого направления (кроме текстов автора). */
  const storyTodo = (routeId: string, style: string, redo: boolean) =>
    routePoints(routeId).filter((p) => !p.story || (redo && p.story_source !== 'author' && (p.story_style ?? 'facts') !== style));

  /** Оценка рассказов маршрута: текст + озвучка для каждой точки из storyTodo. */
  function storiesQuote(route: any, style: string, redo: boolean) {
    const items = storyTodo(route.id, style, redo).map((p) => ({
      pointId: p.id as string,
      ...storyItemQuote(pricing, { writeStory: true, withNarration: !!tts }),
    }));
    return { cost: quoteTotal(items), items };
  }

  /** Оценка для одной точки: новый текст (+ озвучка) или только озвучка текущего текста. */
  const pointStoryQuote = (point: any, keepText: boolean): StoryQuoteItem =>
    storyItemQuote(pricing, { writeStory: !keepText, textChars: (point.story ?? '').length, withNarration: !!tts });

  /**
   * Сколько списать за результат по точке: текст — если создан, озвучка — по фактической длительности,
   * но не дороже оценки (FR-007); если длительность не определилась, — по оценке.
   */
  function pointCharge(res: { storyCreated: boolean; narrationSec: number | null }, est: StoryQuoteItem): number {
    const story = res.storyCreated ? est.story : 0;
    const narration =
      res.narrationSec === null ? 0 : Math.min(res.narrationSec > 0 ? narrationCost(res.narrationSec, pricing) : est.narrationEstimate, est.narrationEstimate);
    return story + narration;
  }

  interface StoriesParams {
    style?: string;
    redo?: boolean;
    billing?: 'free' | 'paid';
    /** Платная задача: точки и оценки, которые пользователь видел и подтвердил. */
    pointIds?: string[];
    estimates?: Record<string, StoryQuoteItem>;
  }

  /** Рассказы для точек маршрута; в платной задаче — списание по каждой точке из резерва задачи. */
  async function storiesJob(job: JobRow, ctl: JobControl, routeId: string, params: StoriesParams) {
    const paid = params.billing === 'paid';
    try {
      const route0 = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId) as any;
      if (!route0) throw new HttpError(404, 'Маршрут удалён');
      const style = params.style ?? route0.story_style ?? 'facts';
      let todo = storyTodo(routeId, style, !!params.redo);
      // Платная задача делает только то, что было в подтверждённой цене.
      if (paid) todo = todo.filter((p) => params.pointIds?.includes(p.id));
      // После перезапуска сервера: готовые точки уже не в списке, счётчик продолжается.
      let { done, failed } = job;
      ctl.update({ stage: 'stories', total: done + todo.length });
      for (const p of todo) {
        if (!ctl.exists()) return;
        const point = db.prepare('SELECT * FROM points WHERE id = ?').get(p.id) as any;
        const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId) as any;
        if (!route) return;
        if (point) {
          try {
            const res = await writePointStory(point, route, { style }, ctl.log);
            res.notices.forEach((n) => ctl.notice(n));
            const h = paid ? findHold(db, 'job', job.id) : undefined;
            const est = params.estimates?.[point.id];
            if (h && est) {
              const amount = Math.min(h.amount, pointCharge(res, est));
              if (amount > 0) {
                captureCharge(h.id, job.user_id, amount, { type: 'job', id: job.id }, {
                  title: `Рассказ: ${point.name}`,
                  routeId,
                  routeTitle: route.title,
                });
              }
            }
          } catch (err: any) {
            failed++;
            ctl.log.warn(err);
            ctl.notice(`Не удалось создать рассказ для «${point.name}»: ${err?.status && err.status < 500 ? err.message : 'попробуйте ещё раз'}`);
          }
        }
        done++;
        ctl.update({ done, failed });
      }
    } finally {
      // Остаток резерва — за точки, где ничего не создалось, и за озвучку дешевле оценки.
      if (paid) {
        const h = findHold(db, 'job', job.id);
        if (h) release(db, h.id);
      }
    }
  }

  const jobs = createJobRunner(
    db,
    {
      generate: async (job, ctl) => {
        const params = JSON.parse(job.params) as {
          request: z.infer<typeof generateSchema>;
          autoStories: boolean;
          billing?: 'free' | 'paid';
          notices?: string[];
        };
        const paid = params.billing === 'paid';
        let routeId = job.route_id;
        if (!routeId) {
          try {
            ctl.update({ stage: 'planning' });
            const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(job.user_id);
            if (!userRow) throw new HttpError(404, 'Пользователь удалён');
            const built = await buildRoute(toUser(userRow), params.request, ctl.log, { free: !paid });
            built.notices.forEach((n) => ctl.notice(n));
            params.notices?.forEach((n) => ctl.notice(n));
            routeId = built.id;
            ctl.update({ route_id: routeId });
          } catch (err) {
            // Маршрут не создан: резерв снимается, баллы возвращаются.
            const h = paid ? findHold(db, 'job', job.id) : undefined;
            if (h) release(db, h.id);
            throw err;
          }
        }
        // После перезапуска резерв уже списан и не находится: второго списания нет.
        const h = paid ? findHold(db, 'job', job.id) : undefined;
        if (h) {
          const title = (db.prepare('SELECT title FROM routes WHERE id = ?').get(routeId) as any)?.title ?? '';
          captureCharge(h.id, job.user_id, h.amount, { type: 'job', id: job.id }, { title: 'Подбор маршрута', routeId, routeTitle: title }, true);
        }
        if (params.autoStories && !paid) {
          await storiesJob({ ...job, route_id: routeId }, ctl, routeId, { style: params.request.storyStyle, billing: 'free' });
        }
      },
      stories: async (job, ctl) => {
        if (!job.route_id) throw new HttpError(404, 'Маршрут удалён');
        await storiesJob(job, ctl, job.route_id, JSON.parse(job.params));
      },
    },
    { concurrency: 2, log: app.log },
  );
  app.addHook('onReady', async () => jobs.resume());
  app.addHook('onClose', async () => jobs.stop());
  app.decorate('jobs', jobs);

  /** Свои задачи (администратор видит любые). */
  function ownedJob(id: string, user: User): JobRow {
    const row = jobs.get(id);
    if (!row || (row.user_id !== user.id && !user.isAdmin)) throw new HttpError(404, 'Задача не найдена');
    return row;
  }

  app.get('/api/jobs/:id', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    return { job: jobView(ownedJob(id, user)) };
  });

  /** Идущие задачи и закончившиеся за последний час: для списка «Мои». */
  app.get('/api/jobs', async (req) => {
    const user = requireUser(req);
    const rows = db
      .prepare(
        `SELECT * FROM jobs WHERE user_id = ? AND (status IN ('queued', 'running') OR updated_at > ?) ORDER BY created_at DESC LIMIT 20`,
      )
      .all(user.id, new Date(Date.now() - 60 * 60_000).toISOString()) as unknown as JobRow[];
    return { jobs: rows.map(jobView) };
  });

  /** Рассказы для всех точек маршрута в фоне. Если задача по маршруту уже идёт — она и возвращается. */
  app.post(
    '/api/routes/:id/stories',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req, reply) => {
      const user = requireUser(req);
      const { id } = paramsId.parse(req.params);
      const body = z
        .object({ style: storyStyleSchema.optional(), redo: z.boolean().default(false), expectedCost: z.number().int().min(0).optional() })
        .parse(req.body ?? {});
      const route = ownedRoute(id, user);
      const running = db
        .prepare("SELECT * FROM jobs WHERE route_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .get(id) as JobRow | undefined;
      if (running) return reply.status(202).send({ job: jobView(running), cost: 0 });
      const style = body.style ?? route.story_style ?? 'facts';
      const jobId = randomUUID();
      let params: StoriesParams = { style, redo: body.redo, billing: 'free' };
      let cost = 0;
      if (charging()) {
        requireSpender(moneyCtx, req);
        const quote = storiesQuote(route, style, body.redo);
        checkExpected(quote.cost, body.expectedCost);
        cost = quote.cost;
        params = {
          ...params,
          billing: 'paid',
          pointIds: quote.items.map((i) => i.pointId),
          estimates: Object.fromEntries(quote.items.map((i) => [i.pointId, { story: i.story, narrationEstimate: i.narrationEstimate }])),
        };
        // Резерв до постановки задачи: обработчик начинает работу сразу и должен его найти.
        if (cost > 0) tx(db, () => hold(db, { userId: user.id, kind: 'charge', amount: cost, refType: 'job', refId: jobId }));
      }
      const job = jobs.enqueue(user.id, 'stories', params, id, jobId);
      return reply.status(202).send({ job: jobView(job), cost });
    },
  );

  app.get('/api/routes/:id/stories/quote', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const q = z.object({ style: storyStyleSchema.optional(), redo: z.enum(['true', 'false']).optional() }).parse(req.query);
    const route = ownedRoute(id, user);
    const quote = storiesQuote(route, q.style ?? route.story_style ?? 'facts', q.redo === 'true');
    return { cost: charging() ? quote.cost : 0, points: quote.items.length, items: charging() ? quote.items : [] };
  });

  /** Бесплатен ли подбор (в пределах месячного лимита) и сколько он стоит сверх лимита. */
  function generationQuote(userId: string, target: { durationMin: number } | { distanceM: number }, roundTrip: boolean) {
    const quota = quotaOf(userId);
    const free = quota.remaining !== 0;
    return {
      free,
      freeLeft: quota.remaining,
      limit: quota.limit,
      cost: free ? 0 : routeCost(routeMinutes(target, roundTrip), pricing),
      paymentsEnabled: charging(),
    };
  }

  app.get('/api/routes/quote', async (req) => {
    const user = requireUser(req);
    const q = z
      .object({
        durationMin: z.coerce.number().min(15).max(480).optional(),
        distanceM: z.coerce.number().min(300).max(30_000).optional(),
        roundTrip: z.enum(['true', 'false']).default('true'),
      })
      .refine((v) => (v.durationMin === undefined) !== (v.distanceM === undefined), {
        message: 'Укажите либо длительность, либо длину маршрута',
      })
      .parse(req.query);
    const target = q.durationMin !== undefined ? { durationMin: q.durationMin } : { distanceM: q.distanceM! };
    return generationQuote(user.id, target, q.roundTrip === 'true');
  });

  /** Подбор мест и запись маршрута; бросает HttpError, если мест нет или источники недоступны. */
  async function buildRoute(
    user: User,
    body: z.infer<typeof generateSchema>,
    log: FastifyBaseLogger,
    opts: { free: boolean } = { free: true },
  ): Promise<{ id: string; notices: string[] }> {
    const target =
      body.durationMin !== undefined ? { durationMin: body.durationMin } : { distanceM: body.distanceM! };

    // Город нужен для каталога. Ищем параллельно с маршрутом; при сбое его допишет фоновая задача.
    const cityLookup = geo.reverseCity(body.start, body.lang).then(
      (c) => c ?? '',
      (err) => {
        log.warn(err);
        return null;
      },
    );

    let plan;
    try {
      plan = await planRoute(
        {
          start: body.start,
          budget: computeBudget(target, body.roundTrip),
          roundTrip: body.roundTrip,
          interests: body.interests,
          lang: body.lang,
        },
        geo,
        ai,
        (err) => log.error(err),
      );
    } catch (err) {
      if (err instanceof NoCandidatesError) {
        throw new HttpError(422, 'Рядом не нашлось достопримечательностей. Выберите другую точку или увеличьте маршрут.');
      }
      log.error(err);
      throw new HttpError(502, 'Не удалось получить данные о достопримечательностях, попробуйте позже');
    }

    const city = await cityLookup;
    const photos = await lookupPhotos(plan.stops, body.lang, log);
    const id = randomUUID();
    const ts = now();
    tx(db, () => {
      db.prepare(
        `INSERT INTO routes (id, owner_id, title, description, lang, is_public, round_trip,
           start_lat, start_lng, start_label, distance_m, duration_min, geometry, planner, created_at, updated_at, city, story_style)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        user.id,
        plan.title,
        plan.description,
        body.lang,
        body.roundTrip ? 1 : 0,
        body.start.lat,
        body.start.lng,
        body.start.label ?? null,
        plan.path.distanceM,
        plan.durationMin,
        JSON.stringify(plan.path.geometry),
        plan.planner,
        ts,
        ts,
        city,
        body.storyStyle,
      );
      plan.stops.forEach((s, i) => {
        insertPoint({
          id: randomUUID(),
          routeId: id,
          position: i,
          name: s.name,
          kind: s.kind,
          lat: s.lat,
          lng: s.lng,
          teaser: s.teaser,
          wikiTitle: s.wikiTitle ?? null,
          wikidata: photos[i]?.wikidata ?? s.wikidata ?? null,
          osmId: s.id.startsWith('osm:') ? s.id.slice(4) : null,
          heritageRef: s.heritageRef ?? null,
          facts: s.facts ?? null,
          photo: photos[i]?.photo ?? null,
        });
      });
      db.prepare('INSERT INTO route_generations (user_id, created_at) VALUES (?, ?)').run(user.id, ts);
      // Маршрут в бесплатном лимите: рассказы и озвучка при создании тоже бесплатны.
      if (opts.free) db.prepare('UPDATE routes SET free_generation = 1 WHERE id = ?').run(id);
    });
    return { id, notices: plan.notices };
  }

  app.post(
    '/api/routes/generate',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req, reply) => {
      const user = requireVerified(req);
      const body = generateSchema.parse(req.body);
      const before = quotaOf(user.id);
      const free = before.remaining !== 0;
      if (!free && !charging()) {
        throw new HttpError(
          429,
          `В этом месяце создано ${before.used} из ${before.limit} маршрутов. Новые можно будет создать с ${ruDate(new Date(before.resetsAt))}. Пока можно менять уже созданные маршруты: добавлять места и менять порядок.`,
        );
      }
      // Сверх бесплатного лимита — за баллы: цена подтверждена пользователем и зарезервирована.
      let cost = 0;
      const extraNotices: string[] = [];
      if (!free) {
        requireSpender(moneyCtx, req);
        const target = body.durationMin !== undefined ? { durationMin: body.durationMin } : { distanceM: body.distanceM! };
        cost = routeCost(routeMinutes(target, body.roundTrip), pricing);
        checkExpected(cost, body.expectedCost);
        if (body.autoStories) extraNotices.push('Рассказы для мест можно заказать после создания маршрута: цена будет видна заранее.');
      }
      if (body.background) {
        const active = (
          db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND kind = 'generate' AND status IN ('queued', 'running')").get(user.id) as any
        ).n as number;
        if (active >= MAX_ACTIVE_JOBS) {
          throw new HttpError(429, `Уже строится ${active} маршрута. Дождитесь, пока они будут готовы.`);
        }
        const jobId = randomUUID();
        // Резерв до постановки задачи: обработчик начинает работу сразу и должен его найти.
        const h = cost > 0 ? tx(db, () => hold(db, { userId: user.id, kind: 'charge', amount: cost, refType: 'job', refId: jobId })) : null;
        let job: JobRow;
        try {
          job = jobs.enqueue(
            user.id,
            'generate',
            { request: body, autoStories: free && body.autoStories, billing: free ? 'free' : 'paid', notices: extraNotices },
            null,
            jobId,
          );
        } catch (err) {
          if (h) release(db, h.id);
          throw err;
        }
        return reply.status(202).send({ job: jobView(job), quota: quotaOf(user.id) });
      }
      const h = cost > 0 ? tx(db, () => hold(db, { userId: user.id, kind: 'charge', amount: cost, refType: 'request', refId: randomUUID() })) : null;
      let built: { id: string; notices: string[] };
      try {
        built = await buildRoute(user, body, req.log, { free });
      } catch (err) {
        if (h) release(db, h.id);
        throw err;
      }
      const row = loadRouteRow(built.id);
      if (h) captureCharge(h.id, user.id, cost, { type: 'route', id: built.id }, { title: 'Подбор маршрута', routeId: built.id, routeTitle: row.title }, true);
      return reply
        .status(201)
        .send({ route: fullRoute(row, user), notices: [...built.notices, ...extraNotices], quota: quotaOf(user.id) });
    },
  );

  /**
   * Маршрут вручную, без подбора и ИИ: пустой, с одним стартом. Месячный лимит не тратит —
   * лимит ограничивает автоматический подбор.
   */
  app.post(
    '/api/routes',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req, reply) => {
      const user = requireVerified(req);
      const body = manualSchema.parse(req.body);
      const city = await geo.reverseCity(body.start, body.lang).then(
        (c) => c ?? '',
        (err) => {
          req.log.warn(err);
          return null;
        },
      );
      const id = randomUUID();
      const ts = now();
      db.prepare(
        `INSERT INTO routes (id, owner_id, title, description, lang, is_public, round_trip,
           start_lat, start_lng, start_label, distance_m, duration_min, geometry, planner, created_at, updated_at, city, story_style)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0, ?, 'manual', ?, ?, ?, ?)`,
      ).run(
        id,
        user.id,
        body.title,
        body.description,
        body.lang,
        body.roundTrip ? 1 : 0,
        body.start.lat,
        body.start.lng,
        body.start.label ?? null,
        JSON.stringify([[body.start.lat, body.start.lng]]),
        ts,
        ts,
        city,
        body.storyStyle,
      );
      return reply.status(201).send({ route: fullRoute(loadRouteRow(id), user) });
    },
  );

  app.get('/api/routes', async (req) => {
    const q = z
      .object({
        sort: z.enum(['rating', 'new']).default('rating'),
        q: z.string().trim().max(100).optional(),
        city: z.string().trim().min(1).max(100).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        radiusKm: z.coerce.number().min(1).max(500).default(30),
        // Вид на карте берёт все старты сразу, список — страницами по 20.
        limit: z.coerce.number().int().min(1).max(500).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where = ['r.is_public = 1'];
    const args: (string | number)[] = [];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.start_label LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    if (q.city) {
      where.push('r.city = ?');
      args.push(q.city);
    }
    if (q.lat !== undefined && q.lng !== undefined) {
      const dLat = q.radiusKm / 111;
      const dLng = q.radiusKm / (111 * Math.max(Math.cos((q.lat * Math.PI) / 180), 0.05));
      where.push('r.start_lat BETWEEN ? AND ? AND r.start_lng BETWEEN ? AND ?');
      args.push(q.lat - dLat, q.lat + dLat, q.lng - dLng, q.lng + dLng);
    }
    // Сглаженное среднее: одна пятёрка не обгоняет маршрут с сотней оценок 4,8.
    const order =
      q.sort === 'rating'
        ? `(COALESCE(rating_avg * rating_count, 0) + 3 * 3.5) / (rating_count + 3) DESC, r.created_at DESC`
        : 'r.created_at DESC';
    const rows = db
      .prepare(
        `SELECT ${ROUTE_COLUMNS} FROM routes r JOIN users u ON u.id = r.owner_id
         WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, q.limit, q.offset);
    return { routes: rows.map(summary) };
  });

  app.get('/api/routes/mine', async (req) => {
    const user = requireUser(req);
    const rows = db
      .prepare(
        `SELECT ${ROUTE_COLUMNS} FROM routes r JOIN users u ON u.id = r.owner_id
         WHERE r.owner_id = ? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .all(user.id);
    return { routes: rows.map(summary) };
  });

  app.get('/api/routes/:id', async (req) => {
    const { id } = paramsId.parse(req.params);
    return { route: fullRoute(visibleRoute(id, req.user), req.user) };
  });

  app.patch('/api/routes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(1000).optional(),
        isPublic: z.boolean().optional(),
        storyStyle: storyStyleSchema.optional(),
      })
      .parse(req.body);
    const row = ownedRoute(id, user);
    if (body.isPublic && !row.is_public) {
      requireVerified(req);
      if (!(db.prepare('SELECT 1 FROM points WHERE route_id = ? LIMIT 1').get(id))) {
        throw new HttpError(409, 'Добавьте в маршрут хотя бы одно место, прежде чем открывать доступ');
      }
    }
    db.prepare('UPDATE routes SET title = ?, description = ?, is_public = ?, story_style = ?, updated_at = ? WHERE id = ?').run(
      body.title ?? row.title,
      body.description ?? row.description,
      body.isPublic === undefined ? row.is_public : body.isPublic ? 1 : 0,
      body.storyStyle ?? row.story_style ?? 'facts',
      now(),
      id,
    );
    return { route: fullRoute(loadRouteRow(id), user) };
  });

  app.delete('/api/routes/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    ownedRoute(id, user);
    const files = db
      .prepare('SELECT m.file_name FROM media m JOIN points p ON p.id = m.point_id WHERE p.route_id = ?')
      .all(id) as any[];
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    await removeFiles(files.map((f) => f.file_name));
    return reply.status(204).send();
  });

  app.put('/api/routes/:id/rating', async (req) => {
    const user = requireVerified(req);
    const { id } = paramsId.parse(req.params);
    const { value } = z.object({ value: z.number().int().min(1).max(5) }).parse(req.body);
    const row = visibleRoute(id, user);
    if (row.owner_id === user.id) throw new HttpError(403, 'Нельзя оценивать собственный маршрут');
    if (!row.is_public) throw new HttpError(404, 'Маршрут не найден');
    db.prepare(
      `INSERT INTO ratings (route_id, user_id, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (route_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(id, user.id, value, now());
    return { route: fullRoute(loadRouteRow(id), user) };
  });

  // ---------- Точки ----------

  app.patch('/api/points/:id', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        teaser: z.string().trim().max(500).optional(),
        story: z.string().trim().max(MAX_STORY_CHARS).optional(),
      })
      .parse(req.body);
    const { point, route } = ownedPoint(id, user);
    const storyChanged = body.story !== undefined && body.story !== point.story;
    db.prepare(
      'UPDATE points SET name = ?, teaser = ?, story = ?, story_source = ?, story_source_url = ?, story_style = ? WHERE id = ?',
    ).run(
      body.name ?? point.name,
      body.teaser ?? point.teaser,
      body.story ?? point.story,
      storyChanged ? 'author' : point.story_source,
      storyChanged ? null : point.story_source_url,
      storyChanged ? null : point.story_style,
      id,
    );
    // Озвучка старого текста расходилась бы с новым.
    if (storyChanged) await dropNarration(id);
    touchRoute(route.id);
    return { route: fullRoute(loadRouteRow(route.id), user) };
  });

  app.delete('/api/points/:id', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const { route } = ownedPoint(id, user);
    const remaining = db
      .prepare('SELECT * FROM points WHERE route_id = ? AND id != ? ORDER BY position')
      .all(route.id, id) as any[];
    if (remaining.length === 0) throw new HttpError(409, 'В маршруте должна остаться хотя бы одна точка');

    const files = db.prepare('SELECT file_name FROM media WHERE point_id = ?').all(id) as any[];
    await rebuildPath(route, remaining, () => db.prepare('DELETE FROM points WHERE id = ?').run(id));
    await removeFiles(files.map((f) => f.file_name));
    return { route: fullRoute(loadRouteRow(route.id), user) };
  });

  app.post('/api/routes/:id/points', async (req, reply) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        ...latLng,
        teaser: z.string().trim().max(500).default(''),
        kind: z.string().trim().max(40).optional(),
        wikiTitle: z.string().trim().min(1).max(300).optional(),
        wikidata: z.string().regex(/^Q\d+$/).optional(),
        heritageRef: z.string().trim().max(40).optional(),
        /** Без позиции точка встаёт туда, где крюк меньше всего. */
        position: z.number().int().min(0).optional(),
      })
      .parse(req.body);
    const route = ownedRoute(id, user);
    const points = routePoints(id);
    if (points.length >= MAX_POINTS) throw new HttpError(409, `В маршруте не больше ${MAX_POINTS} точек`);
    const start = { lat: route.start_lat, lng: route.start_lng };
    if (haversine(start, body) > MAX_POINT_DISTANCE_M) {
      throw new HttpError(422, 'Место слишком далеко от старта для пешей прогулки');
    }

    const pointId = randomUUID();
    const position = Math.min(
      body.position ?? bestInsertion(start, points, body, !!route.round_trip, finishOf(route)),
      points.length,
    );
    const added = { id: pointId, lat: body.lat, lng: body.lng };
    const ordered = [...points.slice(0, position), added, ...points.slice(position)];
    const [found] =
      body.wikiTitle || body.wikidata
        ? await lookupPhotos([{ wikiTitle: body.wikiTitle, wikidata: body.wikidata }], route.lang, req.log)
        : [];
    await rebuildPath(route, ordered, () => {
      insertPoint({
        id: pointId,
        routeId: id,
        position,
        name: body.name,
        kind: body.kind ?? 'manual',
        lat: body.lat,
        lng: body.lng,
        teaser: body.teaser,
        wikiTitle: body.wikiTitle ?? null,
        wikidata: found?.wikidata ?? body.wikidata ?? null,
        heritageRef: body.heritageRef ?? null,
        photo: found?.photo ?? null,
      });
    });
    return reply.status(201).send({ route: fullRoute(loadRouteRow(id), user), pointId });
  });

  const placeSchema = z.object({ ...latLng, label: z.string().trim().max(200).optional() });

  /** Старт и финиш: старт переносится, финиш — у старта, на последней точке или в своём месте. */
  app.patch('/api/routes/:id/endpoints', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .object({
        start: placeSchema.optional(),
        finish: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('start') }),
            z.object({ type: z.literal('last') }),
            z.object({ type: z.literal('point'), ...placeSchema.shape }),
          ])
          .optional(),
      })
      .refine((b) => b.start || b.finish, { message: 'Укажите старт или финиш' })
      .parse(req.body);
    const route = ownedRoute(id, user);
    const points = routePoints(id);

    const next = { ...route };
    if (body.start) {
      next.start_lat = body.start.lat;
      next.start_lng = body.start.lng;
      next.start_label = body.start.label || null;
    }
    if (body.finish) {
      const custom = body.finish.type === 'point' ? body.finish : null;
      next.round_trip = body.finish.type === 'start' ? 1 : 0;
      next.end_lat = custom?.lat ?? null;
      next.end_lng = custom?.lng ?? null;
      next.end_label = custom?.label || null;
    }
    const start = { lat: next.start_lat, lng: next.start_lng };
    const finish = finishOf(next);
    if ([...points, ...(finish ? [finish] : [])].some((p) => haversine(start, p) > MAX_POINT_DISTANCE_M)) {
      throw new HttpError(422, 'Старт и финиш должны быть не дальше 25 км от точек маршрута');
    }

    await rebuildPath(next, points, () => {
      db.prepare(
        `UPDATE routes SET start_lat = ?, start_lng = ?, start_label = ?, round_trip = ?, end_lat = ?, end_lng = ?, end_label = ?
         WHERE id = ?`,
      ).run(next.start_lat, next.start_lng, next.start_label, next.round_trip, next.end_lat, next.end_lng, next.end_label, id);
    });
    if (body.start) {
      // Старт мог уйти в соседний город; ответ не ждёт геокодер, каталог обновится чуть позже.
      geo
        .reverseCity(start, route.lang)
        .then((city) => db.prepare('UPDATE routes SET city = ? WHERE id = ?').run(city ?? '', id))
        .catch((err) => req.log.warn(err));
    }
    return { route: fullRoute(loadRouteRow(id), user) };
  });

  app.put('/api/routes/:id/order', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const body = z
      .union([
        z.object({ pointIds: z.array(z.string().uuid()).min(1).max(MAX_POINTS) }),
        z.object({ auto: z.literal(true) }),
      ])
      .parse(req.body);
    const route = ownedRoute(id, user);
    const points = routePoints(id);
    let ordered: any[];
    if ('auto' in body) {
      ordered = orderStops({ lat: route.start_lat, lng: route.start_lng }, points, !!route.round_trip, finishOf(route));
    } else {
      const byId = new Map(points.map((p) => [p.id, p]));
      // Ровно те же точки, каждая один раз: иначе пропущенная точка выпала бы из маршрута.
      if (body.pointIds.length !== points.length || new Set(body.pointIds).size !== points.length || body.pointIds.some((pid) => !byId.has(pid))) {
        throw new HttpError(409, 'Маршрут изменился, обновите страницу');
      }
      ordered = body.pointIds.map((pid) => byId.get(pid));
    }
    await rebuildPath(route, ordered);
    return { route: fullRoute(loadRouteRow(id), user) };
  });

  app.get(
    '/api/routes/:id/suggestions',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req) => {
      const user = requireUser(req);
      const { id } = paramsId.parse(req.params);
      const route = ownedRoute(id, user);
      const points = routePoints(id);
      const start: LatLng = { lat: route.start_lat, lng: route.start_lng };
      const finish = finishOf(route);
      const all = finish ? [start, ...points, finish] : [start, ...points];
      const center = centroid(all);
      const spread = Math.max(...all.map((p) => haversine(center, p)));
      const radius = Math.round(Math.min(Math.max(spread + 500, 800), 3000));
      let found;
      try {
        found = await geo.findCandidates(center, radius, route.lang);
      } catch (err) {
        req.log.warn(err);
        throw new HttpError(502, 'Не удалось загрузить места рядом, попробуйте позже');
      }
      const taken = new Set(points.map((p) => normalize(p.name)));
      const fresh = found.filter(
        (c) => c.isPlace !== false && !taken.has(normalize(c.name)) && !points.some((p) => haversine(p, c) < 40),
      );
      return {
        suggestions: rankCandidates(fresh, radius)
          .slice(0, 20)
          .map((c) => ({
            name: c.name,
            lat: c.lat,
            lng: c.lng,
            kind: c.kind,
            wikiTitle: c.wikiTitle ?? null,
            wikidata: c.wikidata ?? null,
            heritageRef: c.heritageRef ?? null,
            about: c.about ?? null,
            distanceM: Math.round(Math.min(...points.map((p) => haversine(p, c)), haversine(start, c))),
          })),
      };
    },
  );

  app.get('/api/routes/:id/export', async (req, reply) => {
    const { id } = paramsId.parse(req.params);
    const { format } = z.object({ format: z.enum(['gpx', 'kml']) }).parse(req.query);
    const row = visibleRoute(id, req.user);
    const data = {
      title: row.title,
      description: row.description,
      roundTrip: !!row.round_trip,
      start: { lat: row.start_lat, lng: row.start_lng, label: row.start_label },
      finish: row.end_lat === null ? null : { lat: row.end_lat, lng: row.end_lng, label: row.end_label },
      geometry: JSON.parse(row.geometry),
      points: routePoints(id),
    };
    return reply
      .header('Content-Type', format === 'gpx' ? 'application/gpx+xml; charset=utf-8' : 'application/vnd.google-earth.kml+xml; charset=utf-8')
      .header('Content-Disposition', contentDisposition(row.title, format))
      .header('X-Content-Type-Options', 'nosniff')
      .send(format === 'gpx' ? toGpx(data) : toKml(data));
  });

  /** Без ИИ рассказом служит начало статьи: целые предложения, не длиннее STORY_FALLBACK_CHARS. */
  function storyFromExtract(text: string): string {
    // U+0301: знаки ударения Википедии мешают читать и сбивают озвучку.
    const clean = text.split(/\n==/)[0]!.replace(/\u0301/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length <= STORY_FALLBACK_CHARS) return clean;
    const cut = clean.slice(0, STORY_FALLBACK_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > 200 ? cut.slice(0, end + 1) : cut;
  }

  /** Источники рассказа, которые можно переиспользовать: тексты автора — его личные, их не берём. */
  const SHARED_SOURCES = ['ai', 'ai_sourced', 'ai_facts', 'wikipedia', 'facts'];

  /**
   * Готовый рассказ о том же месте в том же направлении и на том же языке — из любого маршрута.
   * Место узнаётся по элементу Викиданных, статье Википедии или объекту OSM.
   * Сначала берутся рассказы, у которых есть озвучка текущим голосом.
   */
  function findSharedStory(point: any, lang: string, style: string): any | null {
    const keys: string[] = [];
    const args: string[] = [];
    if (point.wikidata) {
      keys.push('p.wikidata = ?');
      args.push(point.wikidata);
    }
    if (point.wiki_title) {
      keys.push('p.wiki_title = ?');
      args.push(point.wiki_title);
    }
    if (point.osm_id) {
      keys.push('p.osm_id = ?');
      args.push(point.osm_id);
    }
    if (!keys.length) return null;
    return db
      .prepare(
        `SELECT p.*,
           (SELECT m.file_name FROM media m WHERE m.point_id = p.id AND m.is_narration = 1 AND m.voice = ?) AS narration_file
         FROM points p JOIN routes r ON r.id = p.route_id
         WHERE p.id != ? AND r.lang = ? AND p.story_style = ? AND p.story IS NOT NULL AND p.story_version >= ?
           AND p.story_source IN (${SHARED_SOURCES.map(() => '?').join(', ')})
           AND (${keys.join(' OR ')})
         ORDER BY narration_file IS NULL, r.updated_at DESC
         LIMIT 1`,
      )
      .get(...[tts?.name ?? '', point.id, lang, style, STORY_VERSION, ...SHARED_SOURCES, ...args]) as any;
  }

  async function saveNarration(pointId: string, write: (file: string) => Promise<number>) {
    const fileName = `${randomUUID()}.mp3`;
    const size = await write(path.join(uploadsDir, fileName));
    await dropNarration(pointId);
    db.prepare(
      `INSERT INTO media (id, point_id, kind, file_name, mime, size, is_narration, created_at, voice)
       VALUES (?, ?, 'audio', ?, 'audio/mpeg', ?, 1, ?, ?)`,
    ).run(randomUUID(), pointId, fileName, size, now(), tts?.name ?? null);
  }

  /**
   * Рассказ и озвучка для точки: готовый из другого маршрута, по источникам с ИИ или без него.
   * Общая часть ручного запроса и фоновой задачи.
   */
  async function writePointStory(
    point: any,
    route: any,
    opts: { keepText?: boolean; fresh?: boolean; style?: string },
    log: FastifyBaseLogger,
  ): Promise<{ notices: string[]; reused: boolean; storyCreated: boolean; narrationSec: number | null }> {
    const id: string = point.id;
    const keepText = !!opts.keepText;
    const body = { fresh: !!opts.fresh, style: opts.style };
    const style = body.style ?? route.story_style ?? 'facts';
    let storyStyle: string | null = point.story_style;

    let story: string = point.story;
    let source: string | null = point.story_source;
    let sourceUrl: string | null = point.story_source_url;
    const notices: string[] = [];
    /** Озвучка из готового рассказа: тот же текст тем же голосом. */
    let sharedNarration: string | null = null;
    let reused = false;

    const shared = !keepText && !body.fresh ? findSharedStory(point, route.lang, style) : null;
    if (shared) {
      story = shared.story;
      source = shared.story_source;
      sourceUrl = shared.story_source_url;
      storyStyle = shared.story_style;
      sharedNarration = shared.narration_file ?? null;
      reused = true;
      db.prepare(
        `UPDATE points SET story = ?, story_source = ?, story_source_url = ?, story_style = ?, story_version = ?,
           wikidata = COALESCE(wikidata, ?), wiki_title = COALESCE(wiki_title, ?), photo = COALESCE(photo, ?) WHERE id = ?`,
      ).run(story, source, sourceUrl, storyStyle, shared.story_version, shared.wikidata, shared.wiki_title, shared.photo, id);
      await dropNarration(id);
    } else if (!keepText || !story) {
      const onLookupError = (err: unknown) => {
        log.warn(err);
        return null;
      };
      const title: string | null =
        point.wiki_title ?? (await geo.findArticle(point.name, point, route.lang).catch(onLookupError));
      if (title && !point.wiki_title) {
        db.prepare('UPDATE points SET wiki_title = ? WHERE id = ?').run(title, id);
      }
      const extract = title ? await geo.wikiExtract(title, route.lang, style).catch(onLookupError) : null;
      const wikidataId: string | null = point.wikidata ?? extract?.wikidata ?? null;
      if (wikidataId && !point.wikidata) {
        db.prepare('UPDATE points SET wikidata = ? WHERE id = ?').run(wikidataId, id);
      }

      // Дополнительные источники, параллельно:
      // - статья Википедии на другом языке, если своей нет или она короткая: ИИ перескажет её на языке маршрута;
      // - справка из Викиданных (с данными реестра наследия): дополняет статью, а без неё служит источником.
      const [other, wd] = await Promise.all([
        ai && wikidataId && (!extract || extract.text.length < SHORT_ARTICLE_CHARS)
          ? geo.otherArticle(wikidataId, route.lang, style).catch(onLookupError)
          : null,
        wikidataId ? geo.placeFacts(wikidataId, route.lang).catch(onLookupError) : null,
      ]);
      const facts = mergeFacts(wd?.facts, parseJson<Fact[]>(point.facts));
      if (point.heritage_ref && !facts.some((f) => f.label === 'Номер в реестре ЕГРОКН')) {
        facts.push({ label: 'Номер в реестре ЕГРОКН', value: point.heritage_ref });
      }
      const factsAbout: string | null = wd?.description ?? null;
      const factsUrl: string | null = wd?.url ?? null;
      const hasFacts = facts.length > 0 || !!factsAbout;
      sourceUrl = extract?.url ?? (hasFacts ? factsUrl : null);

      /** Без ИИ: для легенд — раздел статьи о них, если он есть, иначе обычное начало статьи. */
      const fromWikipedia = (text: string) => {
        if (style === 'legends') {
          const legends = legendSections(text);
          if (legends.length) {
            storyStyle = 'legends';
            // Заголовки разделов и подразделов в рассказ не идут.
            const body = legends.map((s) => s.split('\n').filter((l) => !/^=+.*=+\s*$/.test(l)).join('\n'));
            return storyFromExtract(body.join('\n'));
          }
          notices.push('Легенд об этом месте в Википедии не нашлось, использован обычный текст статьи.');
        }
        storyStyle = 'facts';
        return storyFromExtract(text);
      };
      const fromFacts = () => {
        if (style === 'legends') notices.push('Статьи об этом месте нет, легенд найти не удалось: рассказ составлен по справочным данным.');
        storyStyle = 'facts';
        return factsStory(point.name, factsAbout, facts);
      };
      const sourceText =
        [
          extract?.text,
          other ? `Статья Википедии на другом языке (${other.lang}):\n${other.text}` : null,
          hasFacts ? `Справка:\n${factsSource(point.name, factsAbout, facts)}` : null,
        ]
          .filter(Boolean)
          .join('\n\n') || undefined;

      if (ai) {
        try {
          story = await ai.writeStory({
            name: point.name,
            kind: point.kind ?? undefined,
            lang: route.lang,
            routeTitle: route.title,
            source: sourceText,
            style,
          });
          if (style === 'legends') story = stripNoLegendsNote(story);
          source = extract || other ? 'ai_sourced' : hasFacts ? 'ai_facts' : 'ai';
          sourceUrl = extract?.url ?? other?.url ?? sourceUrl;
          storyStyle = style;
        } catch (err) {
          log.error(err);
          if (extract) {
            story = fromWikipedia(extract.text);
            source = 'wikipedia';
          } else if (hasFacts) {
            story = fromFacts();
            source = 'facts';
          } else throw new HttpError(502, 'Не удалось создать рассказ, попробуйте позже');
          notices.push(extract ? 'ИИ сейчас недоступен, использован текст Википедии.' : 'ИИ сейчас недоступен, использована справка о месте.');
        }
      } else if (extract) {
        story = fromWikipedia(extract.text);
        source = 'wikipedia';
      } else if (hasFacts) {
        story = fromFacts();
        source = 'facts';
      } else throw new HttpError(422, 'Для этой точки нет источника, а ИИ не подключён');

      db.prepare(
        'UPDATE points SET story = ?, story_source = ?, story_source_url = ?, story_style = ?, story_version = ? WHERE id = ?',
      ).run(story, source, sourceUrl, storyStyle, STORY_VERSION, id);
      await dropNarration(id);
    }

    // Длительность озвучки — для цены по факту; null — озвучки нет.
    let narrationSec: number | null = null;
    if (tts) {
      try {
        if (sharedNarration) {
          const from = path.join(uploadsDir, sharedNarration);
          await saveNarration(id, async (to) => {
            await copyFile(from, to);
            return (await stat(to)).size;
          });
          narrationSec = mp3DurationSec(await readFile(from));
        } else {
          const audio = await tts.synthesize(story);
          await saveNarration(id, async (to) => {
            await writeFile(to, audio);
            return audio.length;
          });
          narrationSec = mp3DurationSec(audio);
        }
      } catch (err) {
        log.error(err);
        notices.push('Озвучка не удалась, рассказ прочитает голос устройства.');
      }
    }
    // Фото для точек, созданных до появления фото.
    if (!point.photo && !reused && (point.wiki_title || point.wikidata)) {
      const [found] = await lookupPhotos([{ wikiTitle: point.wiki_title, wikidata: point.wikidata }], route.lang, log);
      if (found?.photo || found?.wikidata) {
        db.prepare('UPDATE points SET photo = COALESCE(photo, ?), wikidata = COALESCE(wikidata, ?) WHERE id = ?').run(
          found.photo ? JSON.stringify(found.photo) : null,
          found.wikidata,
          id,
        );
      }
    }
    touchRoute(route.id);
    return { notices, reused, storyCreated: !keepText, narrationSec };
  }

  app.post(
    '/api/points/:id/story',
    { config: { rateLimit: { max: 120, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req) => {
      const user = requireUser(req);
      const { id } = paramsId.parse(req.params);
      const body = z
        .object({
          keepText: z.boolean().default(false),
          style: storyStyleSchema.optional(),
          /** true — «Создать заново»: написать новый текст, а не брать готовый из другого маршрута. */
          fresh: z.boolean().default(false),
          expectedCost: z.number().int().min(0).optional(),
        })
        .parse(req.body ?? {});
      const { keepText } = body;
      const { point, route } = ownedPoint(id, user);
      let h: ReturnType<typeof hold> | null = null;
      let est: StoryQuoteItem = { story: 0, narrationEstimate: 0 };
      if (charging()) {
        requireSpender(moneyCtx, req);
        est = pointStoryQuote(point, keepText);
        const cost = est.story + est.narrationEstimate;
        checkExpected(cost, body.expectedCost);
        if (cost > 0) h = tx(db, () => hold(db, { userId: user.id, kind: 'charge', amount: cost, refType: 'point', refId: randomUUID() }));
      }
      let result: Awaited<ReturnType<typeof writePointStory>>;
      try {
        result = await writePointStory(point, route, { keepText, fresh: body.fresh, style: body.style }, req.log);
      } catch (err) {
        if (h) release(db, h.id);
        throw err;
      }
      let charged = 0;
      if (h) {
        charged = Math.min(h.amount, pointCharge(result, est));
        if (charged > 0) {
          captureCharge(h.id, user.id, charged, { type: 'point', id: point.id }, {
            title: keepText ? `Озвучка: ${point.name}` : `Рассказ: ${point.name}`,
            routeId: route.id,
            routeTitle: route.title,
          }, true);
        } else release(db, h.id);
      }
      const { notices, reused } = result;
      return { route: fullRoute(loadRouteRow(route.id), user), notices, reused, charged };
    },
  );

  app.get('/api/points/:id/story/quote', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const { keepText } = z.object({ keepText: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const { point } = ownedPoint(id, user);
    const q = charging() ? pointStoryQuote(point, keepText === 'true') : { story: 0, narrationEstimate: 0 };
    return { cost: q.story + q.narrationEstimate, story: q.story, narrationEstimate: q.narrationEstimate };
  });

  // ---------- Ссылка на маршрут ----------

  /** index.html веб-версии перечитывается, только когда файл поменялся после деплоя. */
  let webIndex: { mtimeMs: number; html: string } | null = null;
  async function loadWebIndex(): Promise<string | null> {
    if (!deps.webIndexPath) return null;
    try {
      const info = await stat(deps.webIndexPath);
      if (!webIndex || webIndex.mtimeMs !== info.mtimeMs) {
        webIndex = { mtimeMs: info.mtimeMs, html: await readFile(deps.webIndexPath, 'utf8') };
      }
      return webIndex.html;
    } catch {
      return null;
    }
  }

  /**
   * Страница маршрута для тех, кто открыл ссылку: то же веб-приложение, но с превью для мессенджеров.
   * Приватный маршрут превью не получает — название не должно утечь по чужой ссылке.
   */
  app.get('/route/:id', async (req, reply) => {
    const html = await loadWebIndex();
    if (!html) return reply.status(404).send({ error: 'Веб-версия не настроена' });
    const parsed = paramsId.safeParse(req.params);
    const row = parsed.success ? loadRouteRow(parsed.data.id) : null;
    let page = html;
    if (row?.is_public) {
      const first = db
        .prepare('SELECT photo FROM points WHERE route_id = ? AND photo IS NOT NULL ORDER BY position LIMIT 1')
        .get(row.id) as any;
      const facts = routeFacts(row.distance_m, row.duration_min, row.point_count);
      page = injectShareMeta(html, {
        title: row.title,
        description: [facts, row.city, row.description].filter(Boolean).join('. '),
        url: `${appUrl}/route/${row.id}`,
        image: parseJson<PlacePhoto>(first?.photo)?.url ?? null,
      });
    }
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page);
  });

  // ---------- Медиа ----------

  app.post(
    '/api/points/:id/media',
    { config: { rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: aiKey } } },
    async (req, reply) => {
      const user = requireUser(req);
      const { id } = paramsId.parse(req.params);
      const { route } = ownedPoint(id, user);
      const { count } = db
        .prepare('SELECT COUNT(*) AS count FROM media WHERE point_id = ? AND is_narration = 0')
        .get(id) as any;
      if (count >= MAX_MEDIA_PER_POINT) throw new HttpError(409, `Не больше ${MAX_MEDIA_PER_POINT} файлов на точку`);

      const file = await req.file();
      if (!file) throw new HttpError(400, 'Файл не передан');
      const type = MEDIA_TYPES[file.mimetype];
      if (!type) {
        file.file.resume();
        throw new HttpError(415, 'Формат не поддерживается: нужны JPEG, PNG, WebP, MP3, M4A, AAC, OGG, WAV, MP4, MOV или WebM');
      }

      const fileName = `${randomUUID()}.${type.ext}`;
      const dest = path.join(uploadsDir, fileName);
      await pipeline(file.file, createWriteStream(dest));
      const size = file.file.bytesRead;
      if (file.file.truncated || size > type.maxBytes) {
        await removeFiles([fileName]);
        throw new HttpError(413, `Файл слишком большой: максимум ${Math.round(type.maxBytes / MB)} МБ`);
      }
      const caption = z
        .string()
        .trim()
        .max(300)
        .catch('')
        .parse((file.fields.caption as any)?.value ?? '');
      const mediaId = randomUUID();
      db.prepare(
        `INSERT INTO media (id, point_id, kind, file_name, mime, size, caption, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(mediaId, id, type.kind, fileName, file.mimetype, size, caption, now());
      touchRoute(route.id);
      return reply.status(201).send({ route: fullRoute(loadRouteRow(route.id), user) });
    },
  );

  app.delete('/api/media/:id', async (req) => {
    const user = requireUser(req);
    const { id } = paramsId.parse(req.params);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as any;
    if (!media) throw new HttpError(404, 'Файл не найден');
    const { route } = ownedPoint(media.point_id, user);
    db.prepare('DELETE FROM media WHERE id = ?').run(id);
    await removeFiles([media.file_name]);
    touchRoute(route.id);
    return { route: fullRoute(loadRouteRow(route.id), user) };
  });

  registerMoney(app, moneyCtx);

  registerAdmin(app, {
    db,
    monthWindow,
    quotaOf,
    summary,
    routeColumns: ROUTE_COLUMNS,
    removeFiles,
    hashPassword,
    baseEnv: deps.baseEnv ?? {},
    reconfigure: deps.reconfigure ?? ((env) => servicesFromEnv(env)),
    applyServices,
    status: () => ({
      ai: aiInfo,
      tts: tts?.name ?? null,
      mailer: mailer?.name ?? null,
      routeMonthlyLimit: monthlyLimit,
      appUrl,
    }),
    mailer: () => mailer,
  });

  return app;
}
