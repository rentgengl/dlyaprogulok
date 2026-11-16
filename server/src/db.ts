import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  lang TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  round_trip INTEGER NOT NULL,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  start_label TEXT,
  distance_m INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  geometry TEXT NOT NULL,
  planner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS routes_public ON routes(is_public, start_lat, start_lng);
CREATE INDEX IF NOT EXISTS routes_owner ON routes(owner_id);

CREATE TABLE IF NOT EXISTS points (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  teaser TEXT NOT NULL DEFAULT '',
  wiki_title TEXT,
  story TEXT,
  story_source TEXT,
  story_source_url TEXT
);
CREATE INDEX IF NOT EXISTS points_route ON points(route_id, position);

-- kind: audio | image | video. is_narration = 1: озвучка рассказа, не вложение автора.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  point_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  is_narration INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_point ON media(point_id);

-- Ссылки подтверждения почты; в базе только хэш токена.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);

-- Созданные маршруты для месячного лимита: удаление маршрута лимит не возвращает.
CREATE TABLE IF NOT EXISTS route_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_generations_user ON route_generations(user_id, created_at);

-- Ссылки сброса пароля; в базе только хэш токена.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

-- Фоновые задачи: подбор маршрута (generate) и рассказы для точек (stories).
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  params TEXT NOT NULL,
  route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  notices TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS jobs_route ON jobs(route_id);

-- Настройки, изменённые в админке: перекрывают значения из .env.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS ratings (
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (route_id, user_id)
);
`;

/** Колонки, добавленные после первого выпуска: у старых баз их нужно дописать. */
function migrate(db: DatabaseSync) {
  const columns = (db.prepare('PRAGMA table_info(routes)').all() as { name: string }[]).map((c) => c.name);
  // city: NULL — ещё не определяли, '' — определить не удалось.
  if (!columns.includes('city')) db.exec('ALTER TABLE routes ADD COLUMN city TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS routes_city ON routes(is_public, city)');
  // Свой финиш. NULL — финиш у старта (кольцо) или на последней точке, как задаёт round_trip.
  for (const col of ['end_lat REAL', 'end_lng REAL', 'end_label TEXT', "story_style TEXT NOT NULL DEFAULT 'facts'"]) {
    if (!columns.includes(col.split(' ')[0]!)) db.exec(`ALTER TABLE routes ADD COLUMN ${col}`);
  }
  // Направление рассказа точки; NULL — текст автора или рассказ, созданный до появления выбора.
  const pointColumns = (db.prepare('PRAGMA table_info(points)').all() as { name: string }[]).map((c) => c.name);
  if (!pointColumns.includes('story_style')) db.exec('ALTER TABLE points ADD COLUMN story_style TEXT');
  // Что это за место во внешних источниках: по этим ключам находятся фото, справка и чужие готовые рассказы.
  // facts и photo — JSON: справка из OSM и фото с Commons с автором и лицензией.
  for (const col of ['wikidata TEXT', 'osm_id TEXT', 'heritage_ref TEXT', 'facts TEXT', 'photo TEXT']) {
    if (!pointColumns.includes(col.split(' ')[0]!)) db.exec(`ALTER TABLE points ADD COLUMN ${col}`);
  }
  // Формат рассказа ИИ (см. STORY_VERSION в app.ts); NULL — рассказ первого формата или не от ИИ.
  if (!pointColumns.includes('story_version')) db.exec('ALTER TABLE points ADD COLUMN story_version INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS points_wikidata ON points(wikidata) WHERE wikidata IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS points_wiki_title ON points(wiki_title) WHERE wiki_title IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS points_osm ON points(osm_id) WHERE osm_id IS NOT NULL');

  // Голос озвучки: чужую озвучку можно взять, только если она сделана тем же голосом.
  const mediaColumns = (db.prepare('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
  if (!mediaColumns.includes('voice')) db.exec('ALTER TABLE media ADD COLUMN voice TEXT');

  // Подтверждение почты появилось позже регистрации первых пользователей: их адреса считаются подтверждёнными.
  const userColumns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!userColumns.includes('email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    db.exec('UPDATE users SET email_verified_at = created_at');
  }
  // role: user | admin. blocked_at — вход и сессии запрещены. route_limit — свой месячный лимит
  // (NULL — общий из настроек, 0 — без ограничения).
  for (const col of ["role TEXT NOT NULL DEFAULT 'user'", 'blocked_at TEXT', 'route_limit INTEGER']) {
    if (!userColumns.includes(col.split(' ')[0]!)) db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
