/** Превью ссылки на маршрут для мессенджеров (Open Graph): Telegram, WhatsApp, VK читают их из HTML. */

export interface ShareMeta {
  title: string;
  description: string;
  url: string;
  image?: string | null;
}

const escapeAttr = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Метатеги перед </head>, заголовок страницы — название маршрута. */
export function injectShareMeta(html: string, meta: ShareMeta): string {
  const title = clip(meta.title, 120);
  const description = clip(meta.description.replace(/\s+/g, ' ').trim(), 300);
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', 'Для прогулок'],
    ['og:locale', 'ru_RU'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', meta.url],
    ...(meta.image ? [['og:image', meta.image]] : []),
  ]
    .map(([property, content]) => `<meta property="${property}" content="${escapeAttr(content!)}" />`)
    .concat([
      `<meta name="description" content="${escapeAttr(description)}" />`,
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
    ])
    .join('\n    ');
  const withTitle = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)} · Для прогулок</title>`);
  return withTitle.replace('</head>', `    ${tags}\n  </head>`);
}

/** «2,4 км · 1 ч 10 мин · 6 мест» */
export function routeFacts(distanceM: number, durationMin: number, points: number): string {
  const km = (distanceM / 1000).toFixed(1).replace('.', ',');
  const h = Math.floor(durationMin / 60);
  const m = Math.round(durationMin % 60);
  const time = h ? `${h} ч${m ? ` ${m} мин` : ''}` : `${m} мин`;
  const n10 = points % 10;
  const n100 = points % 100;
  const word = n10 === 1 && n100 !== 11 ? 'место' : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'места' : 'мест';
  return `${km} км · ${time} · ${points} ${word}`;
}
