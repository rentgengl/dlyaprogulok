export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

export function pluralStops(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} остановка`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} остановки`;
  return `${n} остановок`;
}

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «1 декабря» по Москве: месяц лимита сервер считает по московскому времени. */
export function formatMoscowDate(iso: string): string {
  const msk = new Date(Date.parse(iso) + 3 * 60 * 60 * 1000);
  return `${msk.getUTCDate()} ${MONTHS_GENITIVE[msk.getUTCMonth()]}`;
}

export function pluralRoutes(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} маршрут`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} маршрута`;
  return `${n} маршрутов`;
}

/** «Осталось 3 из 5 маршрутов в этом месяце» или «Лимит исчерпан до 1 декабря». */
export function quotaText(quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string }): string | null {
  if (quota.limit === null || quota.remaining === null) return null;
  if (quota.remaining === 0) {
    return `В этом месяце создано ${pluralRoutes(quota.used)} из ${quota.limit}. Новые можно будет создать с ${formatMoscowDate(quota.resetsAt)}.`;
  }
  return `В этом месяце можно создать ещё ${pluralRoutes(quota.remaining)} из ${quota.limit}. Счётчик обновится ${formatMoscowDate(quota.resetsAt)}.`;
}
