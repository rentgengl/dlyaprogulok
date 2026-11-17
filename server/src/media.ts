/**
 * Раздача загруженных файлов (specs/002-monetization, research R10). Файлы бесплатных маршрутов —
 * как раньше, по прямой ссылке. Файлы платных — только по подписанной ссылке ?exp=&sig=, которую
 * получают в fullRoute() те, у кого есть доступ: <audio> и <img> не передают заголовок авторизации.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';

/** Срок подписанной ссылки по умолчанию: 12 часов. */
export const MEDIA_LINK_TTL_SEC = 12 * 60 * 60;

/** Ключ подписи: MEDIA_SIGNING_KEY из .env или созданный при первом запуске и сохранённый в app_secrets. */
export function mediaSigningKey(db: DatabaseSync, env: Record<string, string | undefined>): Buffer {
  if (env.MEDIA_SIGNING_KEY) return Buffer.from(env.MEDIA_SIGNING_KEY, 'utf8');
  db.prepare("INSERT OR IGNORE INTO app_secrets (key, value) VALUES ('media_signing_key', ?)").run(randomBytes(32).toString('hex'));
  const row = db.prepare("SELECT value FROM app_secrets WHERE key = 'media_signing_key'").get() as { value: string };
  return Buffer.from(row.value, 'hex');
}

export interface MediaSigner {
  /** /media/<file>?exp=&sig=. Срок от часа округляется вниз до часа: ссылка не меняется при каждом запросе маршрута. */
  sign(file: string, ttlSec?: number): string;
  verify(file: string, exp: unknown, sig: unknown): boolean;
}

export function createMediaSigner(key: Buffer): MediaSigner {
  const mac = (file: string, exp: number) => createHmac('sha256', key).update(`${file}:${exp}`).digest();
  return {
    sign(file, ttlSec = MEDIA_LINK_TTL_SEC) {
      const raw = Math.floor(Date.now() / 1000) + ttlSec;
      const exp = ttlSec >= 3600 ? raw - (raw % 3600) : raw;
      return `/media/${file}?exp=${exp}&sig=${mac(file, exp).toString('hex')}`;
    },
    verify(file, exp, sig) {
      if (typeof exp !== 'string' || !/^\d{1,12}$/.test(exp) || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
      const e = Number(exp);
      if (e < Math.floor(Date.now() / 1000)) return false;
      return timingSafeEqual(mac(file, e), Buffer.from(sig, 'hex'));
    },
  };
}

/**
 * GET /media/:file. Нужен зарегистрированный @fastify/static с root = каталог загрузок (reply.sendFile).
 * Файл, которого нет в таблице media, не отдаётся.
 */
export function registerMedia(app: FastifyInstance, ctx: { db: DatabaseSync; signer: MediaSigner }) {
  const findRoute = ctx.db.prepare(
    `SELECT r.price FROM media m JOIN points p ON p.id = m.point_id JOIN routes r ON r.id = p.route_id WHERE m.file_name = ?`,
  );
  app.get('/media/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const q = req.query as { exp?: unknown; sig?: unknown };
    if (!/^[\w-]+\.[a-z0-9]{2,5}$/i.test(file)) return reply.status(404).send({ error: 'Файл не найден' });
    const row = findRoute.get(file) as { price: number | null } | undefined;
    if (!row) return reply.status(404).send({ error: 'Файл не найден' });
    if (row.price !== null && !ctx.signer.verify(file, q.exp, q.sig)) {
      return reply.status(403).send({ error: 'Ссылка на файл недействительна или устарела' });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    // Подписанные ссылки не кэшируются общими кэшами.
    if (row.price !== null) reply.header('Cache-Control', 'private, max-age=3600');
    return reply.sendFile(file);
  });
}
