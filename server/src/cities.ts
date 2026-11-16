/** Город для маршрутов, созданных до появления выбора города или когда геокодер не ответил. */
import type { DatabaseSync } from 'node:sqlite';
import type { GeoServices } from './services.ts';

/** Nominatim разрешает не больше запроса в секунду. */
const PAUSE_MS = 1100;

export async function backfillCities(
  db: DatabaseSync,
  geo: GeoServices,
  log: { info(msg: string): void; warn(err: unknown): void },
  pauseMs = PAUSE_MS,
): Promise<number> {
  const rows = db.prepare('SELECT id, start_lat, start_lng, lang FROM routes WHERE city IS NULL').all() as any[];
  const update = db.prepare('UPDATE routes SET city = ? WHERE id = ?');
  let done = 0;
  for (const r of rows) {
    try {
      const city = await geo.reverseCity({ lat: r.start_lat, lng: r.start_lng }, r.lang);
      update.run(city ?? '', r.id);
      done++;
    } catch (err) {
      // Сеть недоступна: остальные тоже не получатся, попробуем при следующем запуске.
      log.warn(err);
      break;
    }
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (rows.length) log.info(`Города определены для маршрутов: ${done} из ${rows.length}`);
  return done;
}
