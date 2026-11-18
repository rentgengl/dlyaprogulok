# Контракт HTTP API — инвентаризация endpoints

Источник: регистрации маршрутов в `server/src/app.ts` и `server/src/admin.ts`.
Это перечень маршрутов, а не полная OpenAPI-спецификация: точные поля запросов/ответов, коды ошибок и схемы Zod следует сверять с исходным кодом.

Монетизация (баллы, платежи ЮKassa, платные маршруты, премии, вывод, денежные разделы админки, подписанные ссылки `/media/*`) описана отдельно: [specs/002-monetization/contracts/api.md](../../002-monetization/contracts/api.md).

## Общие правила

- API имеет префикс `/api`, кроме публичной страницы `/route/:id`.
- Авторизация выполняется сервером по сессии.
- Доступ к приватным маршрутам/материалам и административным операциям проверяется на сервере.
- Для запросов с пользовательским вводом используются Zod-схемы.
- При изменении endpoint синхронно обновлять клиент `app/src/lib/api.ts`, `app/src/lib/adminApi.ts`, типы `app/src/lib/types.ts` и тесты.

## Health, config, geocoding, cities

| Method | Path | Назначение |
|---|---|---|
| GET | `/api/health` | Проверка доступности |
| GET | `/api/config` | Публичная конфигурация клиента |
| GET | `/api/geocode` | Геокодирование |
| GET | `/api/cities` | Список городов |
| GET | `/api/cities/search` | Поиск города |
| GET | `/api/cities/locate` | Определение города по координатам |

## Authentication and profile

| Method | Path | Назначение |
|---|---|---|
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/verify` | Подтверждение почты |
| POST | `/api/auth/resend` | Повторная отправка подтверждения |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/me` | Текущий пользователь |
| POST | `/api/auth/forgot` | Запрос сброса пароля |
| POST | `/api/auth/reset` | Сброс пароля по токену |
| DELETE | `/api/me` | Удаление аккаунта |

## Jobs

| Method | Path | Назначение |
|---|---|---|
| GET | `/api/jobs/:id` | Получить состояние задачи |
| GET | `/api/jobs` | Список задач текущего пользователя |

## Routes and points

| Method | Path | Назначение |
|---|---|---|
| POST | `/api/routes/generate` | Создать маршрут через генерацию |
| POST | `/api/routes` | Создать маршрут вручную |
| GET | `/api/routes` | Каталог публичных маршрутов |
| GET | `/api/routes/mine` | Маршруты пользователя |
| GET | `/api/routes/:id` | Получить маршрут |
| PATCH | `/api/routes/:id` | Изменить маршрут |
| DELETE | `/api/routes/:id` | Удалить маршрут |
| PUT | `/api/routes/:id/rating` | Поставить/изменить оценку |
| PATCH | `/api/points/:id` | Изменить точку |
| DELETE | `/api/points/:id` | Удалить точку |
| POST | `/api/routes/:id/points` | Добавить точку |
| PATCH | `/api/routes/:id/endpoints` | Изменить старт/финиш |
| PUT | `/api/routes/:id/order` | Изменить порядок точек |
| GET | `/api/routes/:id/suggestions` | Предложения мест рядом |
| GET | `/api/routes/:id/export` | Экспорт маршрута |
| POST | `/api/points/:id/story` | Создать/пересоздать рассказ |
| POST | `/api/routes/:id/stories` | Создать рассказы для маршрута |

## Share and media

| Method | Path | Назначение |
|---|---|---|
| GET | `/route/:id` | Публичная HTML-страница/превью маршрута |
| POST | `/api/points/:id/media` | Загрузить медиа к точке |
| DELETE | `/api/media/:id` | Удалить медиа |

## Admin API

| Method | Path | Назначение |
|---|---|---|
| GET | `/api/admin/stats` | Статистика |
| GET | `/api/admin/users` | Список/поиск пользователей |
| GET | `/api/admin/users/:id` | Карточка пользователя |
| PATCH | `/api/admin/users/:id` | Изменить пользователя/права/лимиты |
| POST | `/api/admin/users/:id/quota-reset` | Сбросить счётчик лимита |
| POST | `/api/admin/users/:id/logout` | Завершить сессии |
| DELETE | `/api/admin/users/:id` | Удалить пользователя |
| GET | `/api/admin/routes` | Список маршрутов |
| PATCH | `/api/admin/routes/:id` | Изменить маршрут |
| GET | `/api/admin/settings` | Получить настройки и состояние сервисов |
| PUT | `/api/admin/settings` | Обновить настройки |
| POST | `/api/admin/settings/test-mail` | Проверить отправку почты |

## Непокрытые детали

Перед публикацией формальной OpenAPI-схемы необходимо извлечь из кода:
- схемы параметров path/query/body;
- успешные response schemas;
- коды и тела ошибок;
- rate limits;
- требования к подтверждению почты;
- правила доступа по ролям и владельцу;
- правила пагинации, сортировки и фильтрации.
