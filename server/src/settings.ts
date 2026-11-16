/**
 * Настройки приложения: значения из .env, поверх которых лежат правки из админки (таблица settings).
 * Правки применяются сразу: ИИ, озвучка и почта пересоздаются без перезапуска сервера.
 * Сетевые параметры процесса (порт, каталог данных, прокси) меняются только в .env с перезапуском.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AI } from './ai.ts';
import { createAiFromEnv } from './ai-provider.ts';
import { createMailerFromEnv, type Mailer } from './mail.ts';
import { createTtsFromEnv, type TTS } from './tts.ts';

export type Env = Record<string, string | undefined>;

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  kind: 'text' | 'secret' | 'number' | 'select';
  options?: string[];
  help?: string;
  /** false — только для просмотра: значение берётся из .env при запуске. */
  editable: boolean;
}

const s = (key: string, label: string, group: string, kind: SettingDef['kind'], help?: string, options?: string[]): SettingDef => ({
  key,
  label,
  group,
  kind,
  help,
  options,
  editable: true,
});
const ro = (key: string, label: string, help: string): SettingDef => ({ key, label, group: 'Сервер', kind: 'text', help, editable: false });

export const SETTINGS: SettingDef[] = [
  s('ROUTE_MONTHLY_LIMIT', 'Маршрутов в месяц на пользователя', 'Лимиты', 'number', 'По умолчанию 5; 0 — без ограничения. У отдельного пользователя можно задать свой лимит.'),

  s('AI_PROVIDER', 'Провайдер ИИ', 'ИИ', 'select', 'Пусто — Claude, если задан его ключ, иначе DeepSeek.', ['', 'claude', 'deepseek']),
  s('ANTHROPIC_API_KEY', 'Ключ Claude (Anthropic)', 'ИИ', 'secret'),
  s('CLAUDE_MODEL', 'Модель Claude', 'ИИ', 'text', 'По умолчанию claude-opus-5-5.'),
  s('DEEPSEEK_API_KEY', 'Ключ DeepSeek', 'ИИ', 'secret'),
  s('DEEPSEEK_MODEL', 'Модель DeepSeek', 'ИИ', 'text', 'По умолчанию deepseek-flash; есть deepseek-v4-pro.'),
  s('DEEPSEEK_BASE_URL', 'Адрес API DeepSeek', 'ИИ', 'text', 'По умолчанию https://api.deepseek.com.'),

  s('TTS_PROVIDER', 'Сервис озвучки', 'Озвучка', 'select', 'Пусто — SpeechKit, если задан ключ Яндекса, иначе OpenAI-совместимый сервис.', ['', 'yandex', 'openai']),
  s('YANDEX_API_KEY', 'Ключ Yandex SpeechKit', 'Озвучка', 'secret'),
  s('YANDEX_FOLDER_ID', 'Каталог Yandex Cloud', 'Озвучка', 'text', 'Для API-ключа необязателен.'),
  s('YANDEX_TTS_VOICE', 'Голос SpeechKit', 'Озвучка', 'text', 'alexander, alena, filipp, ermil, jane, omazh, zahar, dasha, julia, kirill, anton…'),
  s('YANDEX_TTS_ROLE', 'Амплуа голоса', 'Озвучка', 'text', 'Например good или neutral; у каждого голоса свой набор.'),
  s('YANDEX_TTS_SPEED', 'Скорость речи', 'Озвучка', 'number', 'От 0.1 до 3, по умолчанию 1.'),
  s('YANDEX_TTS_PITCH', 'Сдвиг высоты голоса, Гц', 'Озвучка', 'number', 'От −1000 до 1000.'),
  s('TTS_BASE_URL', 'Адрес OpenAI-совместимой озвучки', 'Озвучка', 'text', 'Свой Piper: http://localhost:8880/v1.'),
  s('TTS_API_KEY', 'Ключ OpenAI-совместимой озвучки', 'Озвучка', 'secret'),
  s('TTS_MODEL', 'Модель озвучки', 'Озвучка', 'text'),
  s('TTS_VOICE', 'Голос OpenAI-совместимой озвучки', 'Озвучка', 'text', 'Для Piper: denis или dmitri.'),

  s('SMTP_URL', 'SMTP-сервер', 'Почта', 'secret', 'smtps://логин:пароль@сервер:465. Пусто — подтверждение почты не требуется.'),
  s('MAIL_FROM', 'Отправитель писем', 'Почта', 'text', 'Например: Для прогулок <info@dlyaprogulok.ru>'),
  s('MAIL_TRANSPORT', 'Письма в лог вместо отправки', 'Почта', 'select', 'log — только для разработки.', ['', 'log']),

  s('APP_URL', 'Адрес сайта', 'Сайт', 'text', 'Из него строятся ссылки в письмах.'),
  s('MAP_TILE_URL', 'Тайлы карты', 'Сайт', 'text', 'Шаблон с {z}/{x}/{y}. Пусто — tile.openstreetmap.org.'),
  s('MAP_ATTRIBUTION', 'Подпись к карте', 'Сайт', 'text', 'HTML, например © OpenStreetMap contributors.'),

  ro('ADMIN_EMAILS', 'Администраторы из .env', 'Эти адреса получают права администратора при запуске.'),
  ro('PORT', 'Порт', 'Меняется в .env, нужен перезапуск.'),
  ro('HOST', 'Адрес, который слушает сервер', 'Меняется в .env, нужен перезапуск.'),
  ro('DATA_DIR', 'Каталог данных', 'Меняется в .env, нужен перезапуск.'),
  ro('TRUST_PROXY', 'За обратным прокси', 'Меняется в .env, нужен перезапуск.'),
  ro('WEB_INDEX', 'index.html веб-версии', 'Меняется в .env, нужен перезапуск.'),
];

const EDITABLE = new Set(SETTINGS.filter((d) => d.editable).map((d) => d.key));
export const isEditable = (key: string) => EDITABLE.has(key);

/** Правки из админки: ключ → значение; пустая строка — значение явно очищено. */
export function loadOverrides(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.filter((r) => EDITABLE.has(r.key)).map((r) => [r.key, r.value]));
}

export function effectiveEnv(base: Env, overrides: Record<string, string>): Env {
  return { ...base, ...overrides };
}

/** Всё, что зависит от настроек и пересоздаётся при их изменении. */
export interface Services {
  ai: AI | null;
  aiProvider: string | null;
  aiModel: string | null;
  tts: TTS | null;
  mailer: Mailer | null;
  appUrl?: string;
  routeMonthlyLimit: number;
  tiles?: { url: string; attribution: string };
}

/** Бросает понятную ошибку, если настройки несовместимы: такие правки не сохраняются. */
export function servicesFromEnv(env: Env, log?: (msg: string) => void): Services {
  const limitRaw = env.ROUTE_MONTHLY_LIMIT?.trim();
  const routeMonthlyLimit = limitRaw ? Number(limitRaw) : 5;
  if (!Number.isInteger(routeMonthlyLimit) || routeMonthlyLimit < 0) {
    throw new Error(`ROUTE_MONTHLY_LIMIT=${limitRaw}: нужно целое число, 0 — без ограничения`);
  }
  const { ai, provider, model } = createAiFromEnv(env);
  return {
    ai,
    aiProvider: provider ?? null,
    aiModel: model ?? null,
    tts: createTtsFromEnv(env),
    mailer: createMailerFromEnv(env, log),
    appUrl: env.APP_URL || undefined,
    routeMonthlyLimit,
    tiles: env.MAP_TILE_URL ? { url: env.MAP_TILE_URL, attribution: env.MAP_ATTRIBUTION ?? '' } : undefined,
  };
}

/** Секрет не отдаётся целиком: только то, что он задан, и последние символы для сверки. */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  // В SMTP_URL секрет — пароль внутри адреса; сервер и логин видны.
  const url = value.match(/^(\w+:\/\/[^:@/]+:).*(@[^@]*)$/);
  if (url) return `${url[1]}••••${url[2]}`;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

export const ADMIN_EMAILS = (env: Env): string[] =>
  (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
