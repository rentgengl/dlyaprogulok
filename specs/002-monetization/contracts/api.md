# Контракт HTTP API: монетизация

Дополняет [api-contract.md](../../001-baseline-project/contracts/api-contract.md). Общие
правила те же: префикс `/api`, сессия в `Authorization: Bearer`, ошибки
`{ "error": "<текст для пользователя>" }` (+ `code` там, где указан), валидация Zod.
Все суммы — целые баллы, если не указано иное. При изменениях синхронно обновляются
`app/src/lib/api.ts`, `adminApi.ts`, `types.ts` и тесты.

Общие коды ошибок платных действий:

| HTTP | code | Когда |
|---|---|---|
| 403 | `EMAIL_NOT_VERIFIED` | почта не подтверждена (FR-032) |
| 403 | `WALLET_FROZEN` | пользователь заблокирован (FR-025) |
| 402 | `INSUFFICIENT_POINTS` | доступно меньше цены; тело: `{ need, available }` |
| 409 | `PRICE_CHANGED` | цена выше `expectedCost`; тело: `{ cost }` |
| 503 | `PAYMENTS_DISABLED` | `PAYMENTS_PROVIDER` не задан, а действие платное |

## Цены и счёт

| Method | Path | Доступ | Назначение |
|---|---|---|---|
| GET | `/api/pricing` | все | Действующие цены и диапазоны: `{ route3h, story, narration2min, saleCommissionPct, payoutCommissionPct, routePrice: {min,max}, tip: {min,max}, topup: {min,max}, payoutMin, paymentsEnabled }` |
| GET | `/api/wallet` | user | `{ balance, available, frozen, reserved, pendingPayout: PayoutRequest \| null, incomeThisMonth }`; `frozen` — заявка на вывод и возврат, `reserved` — идущая генерация |
| GET | `/api/wallet/history?before=&limit=` | user | Операции пользователя, новые сверху: `{ items: [{ id, kind, amount, createdAt, title, route?: {id,title}, counterparty?: {id,name}, commission?, message? }], next }` |

`GET /api/me` дополнительно отдаёт `wallet: { balance, available }` и прежний `quota`.

## Покупка баллов

| Method | Path | Доступ | Назначение |
|---|---|---|---|
| POST | `/api/payments` | verified | Тело `{ points }` (в `topup.min…max`). Ответ `201 { payment: { id, status, points, confirmationUrl } }`. Ограничение 10/час |
| GET | `/api/payments/:id` | владелец | `{ payment: { id, status, points, createdAt, cancelReason? } }`; при `pending` сервер сверяется с ЮKassa не чаще раза в 5 с |
| POST | `/api/payments/yookassa/notify` | ЮKassa | Уведомление; тело не доверенное (см. [yookassa.md](yookassa.md)). Всегда `200`, кроме чужого IP (`403`) |

## Генерация

Изменения существующих endpoints:

| Method | Path | Изменение |
|---|---|---|
| GET | `/api/routes/quote?durationMin=&distanceM=&roundTrip=` | **новый**: `{ free: boolean, freeLeft, limit, cost, paymentsEnabled }` — для экрана создания; при `paymentsEnabled = false` и исчерпанном лимите подбор недоступен, как раньше |
| POST | `/api/routes/generate` | + `expectedCost` (обязателен, если маршрут не бесплатный). Бесплатный: как сейчас, `autoStories` работает. Платный: ставит резерв на цену маршрута; `autoStories` игнорируется, ответ содержит `notice` о том, что рассказы заказываются отдельно |
| POST | `/api/routes/:id/stories` | + `expectedCost` (обязателен для платного). Ответ `202 { job, cost }` |
| GET | `/api/routes/:id/stories/quote?style=&redo=` | **новый**: `{ cost, points, items: [{ pointId, story, narrationEstimate }] }`; `cost = 0`, если идёт бесплатная первоначальная генерация |
| POST | `/api/points/:id/story` | + `expectedCost`. Ответ дополнительно `{ charged }` |
| GET | `/api/points/:id/story/quote?keepText=` | **новый**: `{ cost, story, narrationEstimate }`; `keepText=true` — только озвучка |

Ответ задач (`GET /api/jobs/:id`) дополнительно: `billing: 'free' \| 'paid'`, `charged`,
`reserved`.

## Платные маршруты

| Method | Path | Доступ | Назначение |
|---|---|---|---|
| PUT | `/api/routes/:id/price` | владелец, verified | `{ price: number \| null }`. Число → `sale_status = 'pending'`, маршрут скрыт из каталога до решения. `null` → маршрут бесплатный, `sale_status = NULL`. Повторная отправка той же цены у `approved` ничего не меняет; новая цена у `approved` — сразу действует без проверки (FR-012b) |
| POST | `/api/routes/:id/purchase` | verified | `{ expectedCost }`. `201 { route }` — полный маршрут. `409 ALREADY_OWNED`, если уже открыт или это автор |

Изменения чтения маршрутов:

- `GET /api/routes` (каталог) — только `price IS NULL OR sale_status = 'approved'`, без
  удалённых; в элементе: `price`, `owned` (куплен/свой).
- `GET /api/routes/:id` — для зрителя без доступа к платному маршруту:
  `{ route: { ...summary, price, locked: true, cover, pointCount, points: [], geometry: null } }`.
  Для владельца — дополнительно `sale: { status, note, decidedAt }` и `buyers` (число).
- `/api/routes/:id/export`, `/suggestions`, `PUT /rating` — `404` для чужого платного
  маршрута без доступа (как для приватного), рейтинг — `403`, если не куплен.
- `DELETE /api/routes/:id` — если есть покупатели: мягкое удаление, ответ `204`;
  `GET /api/routes/:id` для автора после этого — `404`, для покупателя — маршрут с
  `deletedByAuthor: true`.

## Медиа

| Method | Path | Изменение |
|---|---|---|
| GET | `/media/:file` | Файлы бесплатных маршрутов — без изменений. Файлы платных — только с `?exp=<unix>&sig=<hmac-sha256(file + exp)>`; иначе `403`. Ссылки с подписью приходят в `fullRoute()` в полях `url` / `narrationUrl` |

## Премии

| Method | Path | Доступ | Назначение |
|---|---|---|---|
| POST | `/api/tips` | verified | `{ authorId, routeId?, amount, message?, expectedCost }` (`expectedCost = amount`). `201 { tip }`. `400` — себе; `404` — маршрут не виден отправителю. Ограничение 30/час |
| GET | `/api/authors/:id` | все | **новый**: страница автора — `{ author: { id, name }, routes: RouteSummary[] }` (публичные маршруты) |

## Вывод

| Method | Path | Доступ | Назначение |
|---|---|---|---|
| GET | `/api/payouts/quote?points=` | user | `{ points, feePct, fee, payoutRub }` |
| POST | `/api/payouts` | verified | `{ points }`. `201 { payout }`. `409`, если уже есть открытая заявка. Ограничение 5/сутки |
| GET | `/api/payouts` | user | Мои заявки |
| DELETE | `/api/payouts/:id` | владелец | Отозвать открытую заявку → `rejected` с пометкой «отозвана», заморозка снимается |

## Удаление аккаунта

`DELETE /api/me` — без изменений в теле. Если `available > 0` или есть открытая заявка,
без `force: true` отвечает `409 { code: 'HAS_POINTS', balance }` (клиент показывает
предупреждение FR-030). Если у пользователя есть проданные маршруты — аккаунт
обезличивается (R11), иначе удаляется.

## Админка (`/api/admin/*`, только администратор)

| Method | Path | Назначение |
|---|---|---|
| GET | `/api/admin/money/summary?from=&to=` | Сводка: покупки (руб.), выручка генерации, комиссии с продаж/премий, комиссии вывода, выплачено, возвраты, остаток баллов у пользователей; `reconciled: boolean` + список расхождений (SC-003) |
| GET | `/api/admin/money/payments?user=&status=&from=&to=` | Платежи ЮKassa |
| GET | `/api/admin/money/ledger?user=&kind=&from=&to=` | Операции |
| POST | `/api/admin/money/payments/:id/refund` | `{ points, note }` — возврат через ЮKassa (FR-028); `≤` остатка платежа и доступного у пользователя |
| GET | `/api/admin/paid-routes?status=pending` | Очередь проверки |
| POST | `/api/admin/paid-routes/:id/decision` | `{ decision: 'approve' \| 'reject' \| 'delist', note }`; `note` обязателен для reject/delist; `approve` публикует маршрут (`is_public = 1`); письмо автору |
| GET | `/api/admin/payouts?status=open` | Заявки на вывод с историей дохода пользователя |
| POST | `/api/admin/payouts/:id/decision` | `{ decision: 'paid' \| 'rejected', note }`; письмо пользователю |
| GET/PUT | `/api/admin/settings` | Без изменений; новая группа «Монетизация» (см. data-model) |

`GET /api/admin/users/:id` дополнительно: `wallet`, последние операции, открытые заявки.
