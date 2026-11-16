/**
 * Фоновые задачи: подбор маршрута и рассказы для его точек. Задачи хранятся в базе, поэтому
 * пользователь может закрыть приложение, а после перезапуска сервера незаконченные задачи продолжаются.
 * Выполняются в этом же процессе, не больше `concurrency` одновременно.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';

export type JobKind = 'generate' | 'stories';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string | null;
  params: string;
  route_id: string | null;
  done: number;
  total: number;
  failed: number;
  notices: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Что обработчик может менять в своей задаче по ходу работы. */
export interface JobControl {
  update(fields: Partial<Pick<JobRow, 'stage' | 'route_id' | 'done' | 'total' | 'failed'>>): void;
  notice(text: string): void;
  /** Задача всё ещё есть в базе (её маршрут не удалили). */
  exists(): boolean;
  log: FastifyBaseLogger;
}

export type JobHandler = (job: JobRow, ctl: JobControl) => Promise<void>;

const now = () => new Date().toISOString();

export function serializeJob(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    stage: j.stage,
    routeId: j.route_id,
    done: j.done,
    total: j.total,
    failed: j.failed,
    notices: j.notices ? (JSON.parse(j.notices) as string[]) : [],
    error: j.error,
    params: JSON.parse(j.params),
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}
export type JobView = ReturnType<typeof serializeJob>;

export function createJobRunner(
  db: DatabaseSync,
  handlers: Record<JobKind, JobHandler>,
  opts: { concurrency?: number; log: FastifyBaseLogger },
) {
  const concurrency = opts.concurrency ?? 2;
  const active = new Set<Promise<void>>();
  let stopped = false;

  const get = (id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;

  function enqueue(userId: string, kind: JobKind, params: unknown, routeId: string | null = null): JobRow {
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO jobs (id, user_id, kind, status, params, route_id, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(id, userId, kind, JSON.stringify(params ?? {}), routeId, ts, ts);
    kick();
    return get(id)!;
  }

  function control(id: string): JobControl {
    const log = opts.log.child({ job: id });
    return {
      log,
      exists: () => !!get(id),
      update(fields) {
        const keys = Object.keys(fields) as (keyof typeof fields)[];
        if (!keys.length) return;
        db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
          ...keys.map((k) => fields[k] as any),
          now(),
          id,
        );
      },
      notice(text) {
        const row = get(id);
        if (!row) return;
        const list: string[] = row.notices ? JSON.parse(row.notices) : [];
        if (!list.includes(text)) list.push(text);
        db.prepare('UPDATE jobs SET notices = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), now(), id);
      },
    };
  }

  async function run(job: JobRow) {
    const ctl = control(job.id);
    try {
      await handlers[job.kind](job, ctl);
      db.prepare("UPDATE jobs SET status = 'done', stage = NULL, updated_at = ? WHERE id = ?").run(now(), job.id);
    } catch (err: any) {
      ctl.log.error(err);
      const message = err?.status && err.status < 500 ? err.message : (err?.message ?? 'Внутренняя ошибка');
      db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(String(message).slice(0, 500), now(), job.id);
    }
  }

  /** Берёт задачи из очереди, пока есть свободные места. */
  function kick() {
    while (!stopped && active.size < concurrency) {
      const next = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined;
      if (!next) return;
      // Захват: другую копию задачи не возьмёт никто, даже если kick вызван дважды.
      const claimed = db
        .prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), next.id);
      if (!Number(claimed.changes)) continue;
      const p: Promise<void> = run({ ...next, status: 'running' }).finally(() => {
        active.delete(p);
        kick();
      });
      active.add(p);
    }
  }

  return {
    enqueue,
    get,
    kick,
    /** После перезапуска: прерванные задачи снова в очередь, обработчики продолжат с места остановки. */
    resume() {
      db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now());
      kick();
    },
    /** Новые задачи не берутся; ждём начатые. */
    async stop() {
      stopped = true;
      await Promise.allSettled([...active]);
    },
    /** Для тестов: дождаться, пока очередь опустеет. */
    async idle() {
      while (active.size) await Promise.allSettled([...active]);
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
