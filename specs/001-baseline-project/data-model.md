# Модель данных SQLite

Источник истины: `server/src/db.ts`. Схема создаётся через `CREATE TABLE IF NOT EXISTS`; миграции выполняются функцией `migrate()` при открытии БД.

## Сущности

| Таблица | Назначение | Основные поля и связи |
|---|---|---|
| `users` | Учётные записи | `id`, `email`, `name`, `password_hash`, `created_at`, `email_verified_at`, `role`, `blocked_at`, `route_limit` |
| `sessions` | Сессии входа | `token_hash`, `user_id → users`, `expires_at` |
| `routes` | Маршруты | `owner_id → users`, title/description/lang, public flag, start/end coordinates, distance/duration, geometry, planner, city, story_style |
| `points` | Остановки маршрута | `route_id → routes`, position, name, kind, coordinates, teaser, wiki metadata, story/source/style/version, Wikidata/OSM/heritage fields, facts/photo |
| `media` | Медиа точки | `point_id → points`, kind, filename, MIME, size, caption, narration flag, voice |
| `email_tokens` | Подтверждение почты | Хэш токена, `user_id`, expiry |
| `route_generations` | История генераций для лимита | `user_id`, timestamp |
| `password_resets` | Сброс пароля | Хэш токена, `user_id`, expiry |
| `jobs` | Фоновые задачи | `user_id`, kind/status/stage, params, optional route, progress, errors |
| `settings` | Админские настройки | key/value, updated_at, updated_by |
| `ratings` | Оценки маршрутов | composite PK (`route_id`, `user_id`), value 1–5 |

## Отношения и каскады

- `sessions.user_id` ссылается на `users` с `ON DELETE CASCADE`.
- `routes.owner_id` ссылается на `users` с `ON DELETE CASCADE`.
- `points.route_id` ссылается на `routes` с `ON DELETE CASCADE`.
- `media.point_id` ссылается на `points` с `ON DELETE CASCADE`.
- Токены, генерации, jobs и ratings также связаны с пользователями/маршрутами через foreign keys.
- Удаление файлов на диске не обеспечивается самим FK SQLite; это отдельная логика приложения.

## Индексы, видимые в схеме

- `routes_public`, `routes_owner`, `routes_city`
- `points_route`, частичные индексы по Wikidata, Wikipedia title и OSM ID
- `media_point`
- `email_tokens_user`, `route_generations_user`, `password_resets_user`
- `jobs_queue`, `jobs_user`, `jobs_route`

## Миграции

`migrate()` дополняет старые схемы колонками:
- `routes.city`, `end_lat`, `end_lng`, `end_label`, `story_style`;
- `points.story_style`, `wikidata`, `osm_id`, `heritage_ref`, `facts`, `photo`, `story_version`;
- `media.voice`;
- `users.email_verified_at`, `role`, `blocked_at`, `route_limit`.

При добавлении миграций:
1. Проверять `PRAGMA table_info`.
2. Добавлять только отсутствующие колонки/индексы.
3. Проверять совместимость с существующими данными.
4. Добавлять тест на старую схему.
5. Проверять работу на копии реальной БД, не на единственном экземпляре.

## Важные инварианты

- Рейтинг ограничен CHECK 1–5 и уникален для пары маршрут/пользователь.
- Позиции точек определяют порядок остановок.
- Токены подтверждения и сброса хранятся в виде хэшей.
- `media.is_narration` отличает озвучку рассказа от вложения автора.
- `story_version` используется для совместимости формата ИИ-рассказов.
- `route_generations` хранит события генерации; удаление маршрута не должно автоматически возвращать месячный лимит согласно README.
- `settings` может переопределять значения окружения, кроме инфраструктурных параметров, перечисленных в README.

## Требует отдельной проверки

- Политика retention для удалённых файлов и резервных копий.
- Наличие/отсутствие индексов, необходимых фактическим запросам под ожидаемой нагрузкой.
- Поведение миграций при конкурентном старте нескольких процессов.
- Явные версии схемы БД: в текущем просмотренном `db.ts` миграции выполняются проверкой колонок; отдельная таблица schema_version не обнаружена.
