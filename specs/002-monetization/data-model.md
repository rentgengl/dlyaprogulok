# Data Model: Монетизация (002)

SQLite, миграции — в `server/src/db.ts` (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` в
`migrate()`, как для существующих колонок). Суммы: баллы — `INTEGER`, рубли — `INTEGER`
копеек. Время — ISO-строки UTC, как в остальной базе.

## Новые таблицы

### wallets — счёт пользователя

| Поле | Тип | Правила |
|---|---|---|
| user_id | TEXT PK | `users.id`; строка создаётся при первой операции |
| balance | INTEGER NOT NULL DEFAULT 0 | `CHECK (balance >= 0)`; всегда = сумма проводок по `user:<id>` |
| updated_at | TEXT NOT NULL | |

Доступно к трате = `balance − SUM(holds.amount WHERE user_id AND status='active')`.
Внешнего ключа на `users` нет: счёт обезличенного пользователя сохраняется для учёта.

### ledger_tx — операция

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | uuid |
| kind | TEXT NOT NULL | `topup`, `charge`, `route_purchase`, `tip`, `payout`, `refund` |
| actor_id | TEXT | кто инициировал (пользователь или администратор) |
| ref_type | TEXT | `payment`, `job`, `point`, `route`, `tip`, `payout`, `refund` |
| ref_id | TEXT | id связанного объекта |
| meta | TEXT | JSON: цена, процент комиссии, описание для истории, сообщение премии |
| created_at | TEXT NOT NULL | |

### ledger_entries — проводки (неизменяемые)

| Поле | Тип | Правила |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| tx_id | TEXT NOT NULL | → `ledger_tx.id` |
| account | TEXT NOT NULL | `user:<id>`, `sys:yookassa`, `sys:revenue`, `sys:payouts`, `sys:refunds` |
| amount | INTEGER NOT NULL | баллы со знаком; `≠ 0` |
| created_at | TEXT NOT NULL | |

Инварианты (проверяются тестами и командой сверки в админке):
- для каждой `tx_id`: `SUM(amount) = 0`;
- для каждого пользователя: `wallets.balance = SUM(amount) WHERE account = 'user:<id>'`;
- `-SUM(amount) WHERE account = 'sys:yookassa'` = сумма успешных платежей − возвраты (в баллах).

Проводки по видам операций:

| kind | Проводки |
|---|---|
| topup | `sys:yookassa −N`, `user:buyer +N` |
| charge | `user:u −N`, `sys:revenue +N` |
| route_purchase | `user:buyer −P`, `user:author +floor(P·(100−c)/100)`, `sys:revenue +остаток` |
| tip | `user:sender −T`, `user:author +floor(T·(100−c)/100)`, `sys:revenue +остаток` |
| payout | `user:u −N`, `sys:payouts +N` (в `payout_requests` — сумма в копейках и комиссия вывода) |
| refund | `user:u −N`, `sys:refunds +N` |

Комиссия вывода не отдельная проводка: пользователь списывает N баллов, к выплате —
`floor(N·100·(100−w)/100)` копеек; разница — доход сервиса, видна в сводке по заявкам.

### holds — резервы и заморозки

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | |
| kind | TEXT NOT NULL | `charge` (генерация), `payout` (заявка на вывод), `refund` (возврат платежа в обработке) |
| amount | INTEGER NOT NULL | `> 0`; уменьшается по мере списания частями |
| ref_type, ref_id | TEXT | `job` / `point` / `payout` и id |
| status | TEXT NOT NULL | `active` → `captured` \| `released` |
| created_at, updated_at | TEXT NOT NULL | |

Индексы: `(user_id, status)`, `(ref_type, ref_id)`. Активный резерв задачи после перезапуска
сервера находится по `ref_id = job.id` и не создаётся повторно.

### payments — покупка баллов через ЮKassa

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | наш id; уходит в `metadata.payment_id` и `return_url` |
| user_id | TEXT NOT NULL | |
| points | INTEGER NOT NULL | = рубли |
| amount_kop | INTEGER NOT NULL | `points × 100` |
| status | TEXT NOT NULL | `created` → `pending` → `succeeded` \| `canceled` \| `mismatch` (сумма в ЮKassa не совпала, баллы не начислены); возвраты учитываются в `refunded_kop`, статус остаётся `succeeded` |
| provider_id | TEXT UNIQUE | id платежа в ЮKassa |
| confirmation_url | TEXT | куда отправить пользователя |
| refunded_kop | INTEGER NOT NULL DEFAULT 0 | |
| cancel_reason | TEXT | из `cancellation_details` |
| ledger_tx_id | TEXT | заполняется при зачислении; повторное зачисление невозможно |
| created_at, updated_at | TEXT NOT NULL | |

### refunds — возвраты платежей (администратор)

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | |
| payment_id | TEXT NOT NULL | → `payments.id` |
| points | INTEGER NOT NULL | ≤ остаток платежа и ≤ доступно у пользователя |
| status | TEXT NOT NULL | `pending` → `succeeded` \| `canceled` |
| provider_id | TEXT UNIQUE | |
| admin_id | TEXT NOT NULL | |
| ledger_tx_id | TEXT | |
| created_at, updated_at | TEXT NOT NULL | |

Баллы замораживаются (`holds.kind='refund'`) до ответа ЮKassa и списываются при `succeeded`.

### route_purchases — открытые платные маршруты

| Поле | Тип | Правила |
|---|---|---|
| route_id | TEXT NOT NULL | без каскадного удаления: маршрут с покупками не удаляется физически |
| user_id | TEXT NOT NULL | |
| price | INTEGER NOT NULL | цена в момент покупки |
| author_share | INTEGER NOT NULL | |
| ledger_tx_id | TEXT NOT NULL | |
| created_at | TEXT NOT NULL | |

PK `(route_id, user_id)` — повторная покупка невозможна.

### tips — премии

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | |
| sender_id | TEXT NOT NULL | ≠ `author_id` |
| author_id | TEXT NOT NULL | |
| route_id | TEXT | NULL — «Премия автору» |
| amount | INTEGER NOT NULL | в пределах `TIP_MIN…TIP_MAX` |
| author_share | INTEGER NOT NULL | |
| message | TEXT | ≤ 200 символов, обрезка пробелов, без HTML |
| ledger_tx_id | TEXT NOT NULL | |
| created_at | TEXT NOT NULL | |

### payout_requests — заявки на вывод

| Поле | Тип | Правила |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | не более одной заявки со статусом `open` (частичный уникальный индекс) |
| points | INTEGER NOT NULL | ≥ `PAYOUT_MIN`, ≤ доступно |
| fee_pct | INTEGER NOT NULL | зафиксирован при подаче |
| payout_kop | INTEGER NOT NULL | к выплате |
| status | TEXT NOT NULL | `open` → `paid` \| `rejected` |
| admin_note | TEXT | комментарий о переводе или причина отказа |
| hold_id | TEXT NOT NULL | заморозка |
| ledger_tx_id | TEXT | при `paid` |
| created_at, decided_at | TEXT | |
| decided_by | TEXT | |

### app_secrets — служебные секреты сервера

| Поле | Тип | Правила |
|---|---|---|
| key | TEXT PK | `MEDIA_SIGNING_KEY` |
| value | TEXT NOT NULL | генерируется при первом запуске, если не задан в `.env` |

Не показывается в админке и API.

## Изменения существующих таблиц

### routes

| Колонка | Тип | Назначение |
|---|---|---|
| price | INTEGER | NULL — бесплатный; иначе цена в баллах |
| sale_status | TEXT | `pending`, `approved`, `rejected`, `delisted`; NULL — продажа не запрашивалась |
| sale_note | TEXT | причина отказа или снятия |
| sale_decided_at, sale_decided_by | TEXT | |
| free_generation | INTEGER NOT NULL DEFAULT 0 | 1 — маршрут создан в пределах бесплатного лимита |
| deleted_at | TEXT | удалён автором, но есть покупатели |

Индекс каталога: `(is_public, sale_status, city)`.

Состояния продажи:

```text
NULL ──автор включил цену──▶ pending ──одобрено──▶ approved ──снят──▶ delisted
                                │                     │  ▲              │
                                │                     │  └─автор снова──┘ (через pending)
                                └──отклонено──▶ rejected (is_public=0, price=NULL)
автор выключил цену в любом состоянии ▶ NULL (price=NULL); покупки сохраняются
```

### users

| Колонка | Тип | Назначение |
|---|---|---|
| deleted_at | TEXT | обезличенный аккаунт автора с проданными маршрутами (R11) |

### jobs (params JSON)

`billing: 'free' | 'paid'`, `hold_id`, `quoted` (показанная сумма). Новых колонок нет.

### points

Без изменений. Платность рассказа определяется задачей/запросом, а не точкой.

## Настройки (таблица `settings`, группа «Монетизация»)

| Ключ | По умолчанию | Смысл |
|---|---|---|
| PAYMENTS_PROVIDER | пусто | `yookassa`, `fake` (только разработка); пусто — платные функции выключены |
| YOOKASSA_SHOP_ID | | |
| YOOKASSA_SECRET_KEY | | секрет |
| YOOKASSA_CHECK_IP | 1 | проверять IP уведомлений |
| RECEIPT_VAT_CODE | 1 | без НДС |
| RECEIPT_TAX_SYSTEM | 2 | УСН «доходы» |
| RECEIPT_PAYMENT_MODE / RECEIPT_PAYMENT_SUBJECT | full_prepayment / service | |
| PRICE_ROUTE_3H | 50 | |
| PRICE_STORY | 10 | |
| PRICE_NARRATION_2MIN | 10 | |
| NARRATION_CHARS_PER_SEC | 14 | оценка длительности озвучки |
| STORY_AVG_CHARS | 1200 | оценка для заказа рассказов маршрута |
| SALE_COMMISSION_PCT | 20 | продажи и премии |
| PAYOUT_COMMISSION_PCT | 5 | |
| ROUTE_PRICE_MIN / MAX | 50 / 2000 | |
| TIP_MIN / MAX | 10 / 5000 | |
| TOPUP_MIN / MAX | 100 / 15000 | |
| PAYOUT_MIN | 500 | |

Когда `PAYMENTS_PROVIDER` пуст, сервис работает как сейчас: лимит есть, платных действий нет
(сверх лимита — отказ, как сегодня). Это позволяет выкатывать код до подключения ЮKassa.
