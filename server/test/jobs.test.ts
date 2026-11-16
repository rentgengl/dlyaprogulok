import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { openDb } from '../src/db.ts';
import { createJobRunner, type JobRow } from '../src/jobs.ts';

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, silent: noop, level: 'silent', child: () => log } as unknown as FastifyBaseLogger;

test('задачи: очередь, ограничение параллельности, продолжение после перезапуска, ошибка', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  try {
    const file = path.join(dir, 'db.sqlite');
    const db = openDb(file);
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', '2026-01-01')").run();

    // Первый запуск: задача «зависает» на середине, сервер останавливается.
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const first = createJobRunner(
      db,
      {
        generate: async (job, ctl) => {
          running++;
          peak = Math.max(peak, running);
          ctl.update({ stage: 'planning', done: 1, total: 3 });
          seen.push(job.id);
          await gate;
          running--;
        },
        stories: async () => {
          throw Object.assign(new Error('Маршрут удалён'), { status: 404 });
        },
      },
      { concurrency: 2, log },
    );
    const jobs = [1, 2, 3].map(() => first.enqueue('u1', 'generate', { n: 1 }));
    assert.equal(peak, 2, 'одновременно не больше двух');
    const states = () => (db.prepare('SELECT status FROM jobs ORDER BY created_at').all() as any[]).map((r) => r.status);
    assert.deepEqual(states().sort(), ['queued', 'running', 'running']);

    // «Перезапуск»: новый запуск подхватывает прерванные задачи с сохранённым прогрессом.
    const resumed: JobRow[] = [];
    const second = createJobRunner(
      db,
      {
        generate: async (job) => void resumed.push(job),
        stories: async () => {
          throw Object.assign(new Error('Маршрут удалён'), { status: 404 });
        },
      },
      { concurrency: 2, log },
    );
    second.resume();
    await second.idle();
    assert.equal(resumed.length, 3);
    assert.ok(resumed.some((j) => j.done === 1 && j.stage === 'planning'), 'прогресс сохранён');
    assert.deepEqual(states(), ['done', 'done', 'done']);

    // Ошибка обработчика: задача помечается failed с текстом.
    const bad = second.enqueue('u1', 'stories', {});
    await second.idle();
    const row = second.get(bad.id)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'Маршрут удалён');

    release();
    await first.stop();
    assert.equal(jobs.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
