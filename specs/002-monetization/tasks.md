---

description: "Задачи реализации монетизации (002)"
---

# Tasks: Монетизация — платная генерация, платные маршруты и поддержка авторов

**Input**: Design documents from `specs/002-monetization/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md),
[contracts/yookassa.md](contracts/yookassa.md), [quickstart.md](quickstart.md)

**Tests**: включены. Спецификация их явно не требует, но конституция (принцип V —
негативные тесты на изменения доступа, принцип VII — тесты денежной логики) делает их
обязательными. Тесты пишутся до реализации своей истории и сначала падают.

**Organization**: задачи сгруппированы по пользовательским историям; каждая история
проверяется отдельно.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: можно делать параллельно (другие файлы, нет зависимости от незавершённых задач)
- **[Story]**: история из spec.md (US1…US5)
- Пути — от корня репозитория: сервер `server/src/`, тесты `server/test/`, клиент `app/src/`

## Общие соглашения для всех задач

- Баллы — `INTEGER`; рубли в платежах — `INTEGER` копеек (`points × 100`).
- Любое движение баллов — только через `server/src/ledger.ts` (T006), внутри `tx(db, …)`.
- Ошибки платных действий — `HttpError` с `code` (T004): `EMAIL_NOT_VERIFIED`,
  `WALLET_FROZEN`, `INSUFFICIENT_POINTS` (402, тело `{ need, available }`),
  `PRICE_CHANGED` (409, тело `{ cost }`), `PAYMENTS_DISABLED` (503).
- Если `PAYMENTS_PROVIDER` пуст — поведение как до функции (quickstart, сценарий 7).
- Тесты — по образцу `server/test/features.test.ts` (`buildApp` во временной папке,
  `app.inject`, fake-зависимости); тексты ошибок — по-русски.
- После каждой задачи: `npm --prefix server run typecheck` и относящиеся тесты; для
  клиента — `npm --prefix app run typecheck` и `npm --prefix app run lint`.

---

## Phase 1: Setup (общая инфраструктура)

**Purpose**: настройки и типы, от которых зависят все истории

- [X] T001 Добавить группу настроек «Монетизация» в `server/src/settings.ts`: ключи и значения по умолчанию из таблицы «Настройки» в data-model.md (`PAYMENTS_PROVIDER` select `['', 'yookassa', 'fake']`; `YOOKASSA_SECRET_KEY` kind `secret`; `YOOKASSA_SHOP_ID`, `YOOKASSA_CHECK_IP`=1, `RECEIPT_VAT_CODE`=1, `RECEIPT_TAX_SYSTEM`=2, `RECEIPT_PAYMENT_MODE`=full_prepayment, `RECEIPT_PAYMENT_SUBJECT`=service, `PRICE_ROUTE_3H`=50, `PRICE_STORY`=10, `PRICE_NARRATION_2MIN`=10, `NARRATION_CHARS_PER_SEC`=14, `STORY_AVG_CHARS`=1200, `SALE_COMMISSION_PCT`=20, `PAYOUT_COMMISSION_PCT`=5, `ROUTE_PRICE_MIN/MAX`=50/2000, `TIP_MIN/MAX`=10/5000, `TOPUP_MIN/MAX`=100/15000, `PAYOUT_MIN`=500). В `servicesFromEnv` собрать объект `pricing` (целые числа, проценты 0…100, `min ≤ max`, иначе понятная ошибка, как для `ROUTE_MONTHLY_LIMIT`) и поле `paymentsProvider`; бросать ошибку при `NODE_ENV=production` и `PAYMENTS_PROVIDER=fake`, а также при `yookassa` без shopId/ключа
- [X] T002 [P] Описать новые переменные в `server/.env.example` (группа «Монетизация», без реальных значений; комментарий: адрес уведомлений `https://<домен>/api/payments/yookassa/notify`)
- [X] T003 [P] Добавить клиентские типы в `app/src/lib/types.ts`: `Pricing`, `Wallet` (`balance`, `available`, `frozen`, `pendingPayout`, `incomeThisMonth`), `LedgerItem`, `Payment` (`status: 'created'|'pending'|'succeeded'|'canceled'|'mismatch'`), `PayoutRequest` (`status: 'open'|'paid'|'rejected'`), `SaleStatus` (`'pending'|'approved'|'rejected'|'delisted'`), `Quote`; расширить `RouteSummary` полями `price`, `owned`, `locked`, а `User` — полем `wallet`

---

## Phase 2: Foundational (блокирует все истории)

**Purpose**: схема, журнал, цены, каркас модуля денег

**⚠️ CRITICAL**: истории не начинаются до завершения фазы

- [X] T004 Добавить необязательное поле `code` в `HttpError` (`server/src/errors.ts`: `constructor(status, message, code?, extra?)`) и выводить `{ error, code, ...extra }` в `setErrorHandler` в `server/src/app.ts`
- [X] T005 Добавить таблицы и колонки в `server/src/db.ts` строго по data-model.md: `wallets` (`balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)`), `ledger_tx`, `ledger_entries` (`amount INTEGER NOT NULL`, `≠ 0`), `holds` (`kind`: `charge` | `payout` | `refund`; `status`: `active` → `captured` | `released`; индексы `(user_id, status)`, `(ref_type, ref_id)`), `payments` (`provider_id TEXT UNIQUE`, статусы `created`/`pending`/`succeeded`/`canceled`/`mismatch`, `refunded_kop INTEGER NOT NULL DEFAULT 0`), `refunds`, `route_purchases` (PK `(route_id, user_id)`, без `ON DELETE CASCADE`), `tips` (`message` ≤ 200), `payout_requests` (частичный уникальный индекс `(user_id) WHERE status = 'open'`), `app_secrets`; в `migrate()` — колонки `routes.price`, `sale_status`, `sale_note`, `sale_decided_at`, `sale_decided_by`, `free_generation INTEGER NOT NULL DEFAULT 0`, `deleted_at`, индекс `(is_public, sale_status, city)`; `users.deleted_at`. У новых таблиц нет внешних ключей на `users` (журнал переживает удаление пользователя)
- [X] T006 Создать `server/src/ledger.ts`: `post(db, { kind, actorId, refType, refId, meta, entries: [{ account, amount }] })` — проверяет `SUM(amount) = 0`, пишет `ledger_tx` + `ledger_entries`, меняет `wallets.balance` для счетов `user:<id>` (создаёт строку при первой операции); `available(db, userId)` = `balance − SUM(active holds)`; `hold(db, { userId, kind, amount, refType, refId })` — отказ `INSUFFICIENT_POINTS`, если доступно меньше; `capture(db, holdId, amount, { kind, entries… })` — списание части резерва проводкой и уменьшение `holds.amount`; `release(db, holdId)`; `findHold(db, refType, refId)`; `splitShare(price, pct)` = `floor(price·(100−pct)/100)` и остаток (реализовано в `server/src/pricing.ts`); `reconcile(db)` — список расхождений по трём инвариантам из data-model.md. Все функции вызываются внутри `tx()` вызывающего кода
- [X] T007 [P] Тесты журнала в `server/test/ledger.test.ts`: сумма проводок 0; остаток = сумма проводок; `CHECK balance >= 0` не даёт уйти в минус; два резерва на последние баллы — второй получает `INSUFFICIENT_POINTS`; частичное списание и снятие остатка; `splitShare(53, 20)` = 42/11; `reconcile` пуст после серии операций и находит подделанный `wallets.balance`
- [X] T008 Создать `server/src/pricing.ts`: `routeCost(minutes, p)` = `ceil(minutes/180)·PRICE_ROUTE_3H`; `routeMinutes(request)` — `durationMin` или `estimateDurationMin(distanceM)` из `geo.ts`; `storyCost(p)`; `narrationCost(sec, p)` = `ceil(sec/120)·PRICE_NARRATION_2MIN`; `narrationEstimateSec(chars, p)` = `ceil(chars / NARRATION_CHARS_PER_SEC)`; `storiesQuote(points, p, { withNarration })` с оценкой по `STORY_AVG_CHARS` для точек без текста и по фактическому тексту для точек с текстом; `payoutQuote(points, pct)` → `{ fee, payoutKop }` = `floor(points·100·(100−pct)/100)`
- [X] T009 [P] Тесты цен в `server/test/pricing.test.ts`: 180 мин → 50, 181 → 100, 480 → 150; озвучка 121 с → 20; `payoutQuote(1000, 5)` → 95000 коп.; маршрут по длине считается через ту же оценку времени, что показывает приложение
- [X] T010 [P] Добавить `mp3DurationSec(buf: Buffer): number` в `server/src/tts.ts` (обход MPEG-кадров: версия, слой, битрейт, частота, padding; пропуск ID3) и тест на сгенерированном буфере из нескольких кадров в `server/test/pricing.test.ts`
- [X] T011 Создать `server/src/money.ts` с `registerMoney(app, ctx)` по образцу `registerAdmin` и подключить его в конце `buildApp` в `server/src/app.ts`; `ctx`: `db`, `requireUser`, `requireVerified`, `pricing()`, `gateway()`, `mailer()`, `appUrl()`, `log`. В `money.ts` — помощник `requireSpender(req)`: `requireVerified` (+ `code: 'EMAIL_NOT_VERIFIED'`), `blocked_at` → `WALLET_FROZEN`, нет шлюза → `PAYMENTS_DISABLED`; помощник `checkExpected(cost, expectedCost)` → `PRICE_CHANGED`
- [X] T012 Реализовать `GET /api/pricing`, `GET /api/wallet`, `GET /api/wallet/history?before=&limit=` в `server/src/money.ts` по contracts/api.md (история — из `ledger_entries` пользователя с `ledger_tx.meta`: название операции, маршрут, контрагент, комиссия, сообщение премии); добавить `wallet: { balance, available }` в `publicUser()` в `server/src/app.ts`

**Checkpoint**: схема, журнал и цены готовы; `npm test` зелёный

---

## Phase 3: User Story 1 — Покупка баллов и оплата генерации (P1) 🎯 MVP

**Goal**: пользователь покупает баллы через ЮKassa и платит ими за генерацию сверх
бесплатного лимита; бесплатный лимит (5 маршрутов с рассказами и озвучкой) сохраняется.

**Independent Test**: quickstart, сценарии 1, 2 и 7.

### Tests for User Story 1 ⚠️

- [X] T013 [P] [US1] Тесты покупки баллов в `server/test/money.test.ts` (fake-шлюз): успешная оплата начисляет баллы ровно один раз при двух уведомлениях; отмена — баллы не меняются; уведомление с телом `succeeded`, но `getPayment` отвечает `pending` — начисления нет; уведомление с чужого IP при `YOOKASSA_CHECK_IP=1` — 403; сумма в ЮKassa не совпала — статус `mismatch`, начисления нет; `points` вне `TOPUP_MIN…MAX` — 400; без подтверждённой почты — `EMAIL_NOT_VERIFIED`; `GET /api/payments/:id` чужого платежа — 404
- [X] T014 [P] [US1] Тесты платной генерации в `server/test/money.test.ts`: в пределах лимита — списаний нет и рассказы с озвучкой бесплатны; сверх лимита — без `expectedCost` или с меньшим — `PRICE_CHANGED`; недостаточно баллов — 402 `{ need, available }`; успешный подбор списывает ровно цену; ошибка «нет мест» снимает резерв; перезапуск runner'а во время задачи не создаёт второй резерв; заказ рассказов: ошибка ИИ на одной точке — за неё не списано; озвучка списывается как `min(факт, оценка)`; повторная генерация рассказа на бесплатном маршруте платная; без `PAYMENTS_PROVIDER` сверх лимита — прежняя ошибка 429 о лимите

### Implementation for User Story 1

- [X] T015 [US1] Создать `server/src/payments.ts`: интерфейс `PaymentGateway` и реализации `yookassa` (HTTP API v3 через `fetch`, Basic-auth, `Idempotence-Key`, тайм-аут 15 с, `receipt` из настроек) и `fake` (в памяти; `confirmationUrl = ${APP_URL}/wallet?payment=<id>&fake=1`; методы `succeed(id)`/`cancel(id)` для тестов) строго по contracts/yookassa.md; секретный ключ не попадает в логи и тексты ошибок; создание шлюза из `Services` в `server/src/settings.ts`
- [X] T016 [US1] Реализовать в `server/src/money.ts` `POST /api/payments` (лимит 10/час, `points` в `TOPUP_MIN…MAX`, запись `payments` со статусом `created` → вызов шлюза → `pending` + `confirmation_url`; `return_url = ${APP_URL}/wallet?payment=<id>`), `GET /api/payments/:id` (только владелец; при `pending` сверка с ЮKassa не чаще раза в 5 с), функцию `applyProviderStatus(paymentId)` с идемпотентным начислением (`UPDATE … WHERE status IN ('created','pending')` + проводка `topup`: `sys:yookassa −N`, `user +N` в одной транзакции) и проверкой суммы (`mismatch`)
- [X] T017 [US1] Реализовать `POST /api/payments/yookassa/notify` в `server/src/money.ts`: проверка IP по списку диапазонов ЮKassa при `YOOKASSA_CHECK_IP=1` (с учётом `TRUST_PROXY`), тело — только источник `object.id`, статус — из `getPayment`; всегда `200`, ошибки — в лог; при `fake` дополнительно `POST /api/dev/fake-payments/:id` (`{ result: 'succeeded' | 'canceled' }`)
- [X] T018 [US1] Фоновая сверка в `server/src/money.ts`: таймер каждые 10 минут и однократно при запуске (запуск в `onReady`, остановка в `onClose`) — платежи `pending` моложе 24 ч сверяются с ЮKassa, старше — помечаются `canceled` после подтверждения через `getPayment`; снимаются зависшие резервы: активный `holds.kind = 'charge'` с `ref_type = 'job'`, у которого нет задачи `queued`/`running` с этим id, и с `ref_type = 'request'` старше 10 минут (research R2). Тест в `server/test/money.test.ts`: резерв удалённой вместе с маршрутом задачи снимается
- [X] T019 [US1] Добавить `GET /api/routes/quote?durationMin=&distanceM=` в `server/src/app.ts` (`{ free, freeLeft, limit, cost }` по `quotaOf` и `pricing.ts`)
- [X] T020 [US1] Изменить `POST /api/routes/generate` и обработчик задачи `generate` в `server/src/app.ts`: бесплатный маршрут — как сейчас, задача получает `params.billing = 'free'`, `buildRoute` ставит `routes.free_generation = 1`, автоматическая задача рассказов наследует `billing: 'free'`; платный — `requireSpender`, `checkExpected`, резерв `hold(kind 'charge', ref 'job')` на цену маршрута (для синхронного режима — ref на временный id запроса), `autoStories` игнорируется с `notice` «Рассказы для мест можно заказать после создания маршрута», после успешного `buildRoute` — `capture` полной цены, при ошибке — `release`; перед резервом проверять существующий резерв задачи через `findHold` (продолжение после перезапуска)
- [X] T021 [US1] Изменить `writePointStory` в `server/src/app.ts`, чтобы он возвращал `{ storyCreated: boolean, narrationSec: number | null }` (длительность — `mp3DurationSec` для новой и скопированной озвучки; `null`, если озвучки нет или она не удалась)
- [X] T022 [US1] Добавить `GET /api/routes/:id/stories/quote?style=&redo=` в `server/src/app.ts` и биллинг в `POST /api/routes/:id/stories` и `storiesJob`: `cost = 0`, если задача бесплатная (`billing: 'free'`); иначе `requireSpender`, `checkExpected`, резерв на квоту, после каждой точки — `capture` (`storyCost`, если рассказ создан, + `min(narrationCost(факт), оценка точки)`, если озвучка есть), в конце задачи — `release` остатка; квота и оценки сохраняются в `job.params` (`hold_id`, `quoted`, оценки по точкам)
- [X] T023 [US1] Добавить `GET /api/points/:id/story/quote?keepText=` и биллинг в `POST /api/points/:id/story` в `server/src/app.ts` (`keepText=true` — только озвучка; `expectedCost`; резерв → `capture` по факту → `release`; ответ `{ charged }`); авторские тексты и загруженные автором файлы бесплатны (FR-010)
- [X] T024 [US1] Дополнить `serializeJob` в `server/src/jobs.ts` полями `billing`, `charged`, `reserved` из `params` и резерва (реализовано как `jobView()` в `server/src/app.ts`: суммы берутся из журнала; в `jobs.ts` — только необязательный id в `enqueue`)
- [X] T025 [P] [US1] Клиентский API в `app/src/lib/api.ts`: `pricing`, `wallet`, `walletHistory`, `createPayment`, `getPayment`, `fakePay`, `routeQuote`, `storiesQuote`, `pointStoryQuote`, параметр `expectedCost` в `generate`, `generateStories`, `pointStory`; `ApiError` хранит `code` и тело (`need`, `available`, `cost`)
- [X] T026 [P] [US1] Компонент `app/src/components/PriceConfirm.tsx`: показывает цену, доступно и остаток после списания, кнопку «Подтвердить»; при `INSUFFICIENT_POINTS` — «Не хватает N баллов» и кнопку «Купить баллы» (переход на `/wallet`; на iOS — только «Недостаточно баллов», без кнопки покупки и без упоминания сайта или других способов оплаты: правило App Store 3.1.1); при `PRICE_CHANGED` — показывает новую цену и просит подтвердить снова
- [X] T027 [US1] Экран `app/src/app/wallet.tsx` и регистрация в `app/src/app/_layout.tsx` («Баллы»): доступно/заморожено, покупка (кнопки 100/300/500/1000 и своя сумма в `topup.min…max`, ссылка на оферту), на iOS (`Platform.OS === 'ios'`) блока покупки нет; веб — `location.assign(confirmationUrl)`, Android — `Linking.openURL`; при `?payment=<id>` и при возвращении приложения на передний план (`AppState`) — опрос `getPayment` каждые 3 с до конечного статуса (не дольше 2 мин); в режиме `fake=1` — кнопки «Оплатить»/«Отменить»; история операций с подгрузкой
- [X] T028 [US1] Экран создания `app/src/app/(tabs)/create.tsx`: перед запуском запросить `routeQuote` и показать «Бесплатно, осталось N из M» или цену через `PriceConfirm`; передать `expectedCost`; для платного маршрута не предлагать автоматические рассказы; для бесплатного — подсказка у переключателя «Рассказы сразу»: «Рассказы и озвучка бесплатны только при создании маршрута»
- [X] T029 [US1] Страница маршрута `app/src/app/route/[id].tsx`: кнопка «Рассказы для мест» с ценой из `storiesQuote` и `PriceConfirm`; «Создать заново»/«Озвучить» для точки — с ценой из `pointStoryQuote`; в статусе задачи — списано/зарезервировано
- [X] T030 [US1] Профиль `app/src/app/(tabs)/profile.tsx`: строка «Баллы: N» со ссылкой на `/wallet`; ссылка `rasskazhi://wallet` открывает экран «Баллы» (expo-router, проверить на Android)

**Checkpoint**: US1 работает отдельно — покупка, лимит, платная генерация (quickstart 1, 2, 7)

---

## Phase 4: User Story 2 — Платные закрытые маршруты (P2)

**Goal**: автор продаёт маршрут за баллы после проверки администратором; содержимое закрыто
на всех путях доступа до покупки.

**Independent Test**: quickstart, сценарий 3. Зависит от US1 (у покупателя должны быть баллы).

### Tests for User Story 2 ⚠️

- [ ] T031 [P] [US2] Тесты в `server/test/paid-routes.test.ts`: цена → `pending`, маршрута нет в каталоге; одобрение → в каталоге с ценой; отклонение → `is_public = 0`, `price = NULL`, письмо с причиной; цена вне `ROUTE_PRICE_MIN…MAX` — 400; без доступа `GET /api/routes/:id` отдаёт превью без `points` и `geometry`; экспорт и подсказки — 404; оценка — 403; `/media/<файл платного маршрута>` без подписи, с чужой и с просроченной подписью — 403, с верной — 200; файлы бесплатных маршрутов — 200 без подписи; рассказ платного маршрута не подставляется в чужой маршрут по тому же месту; покупка за 100 → −100 / +80 / +20 и полный доступ; повторная покупка и покупка своего — 409; автор и администратор видят всё без покупки; удаление маршрута с покупателями — у автора 404, у покупателя доступен с `deletedByAuthor`; удаление аккаунта автора с продажами — обезличивание, покупатель сохраняет доступ; заблокированный пользователь не может купить (`WALLET_FROZEN`); покупка маршрута в статусе `pending`, `rejected`, `delisted` — 404; `PUT /api/routes/:id/price` чужого маршрута — 404; не-администратор получает 403 на `GET /api/admin/paid-routes` и `POST /api/admin/paid-routes/:id/decision`; одобрение приватного маршрута делает его опубликованным и видимым в каталоге

### Implementation for User Story 2

- [ ] T032 [US2] Создать `server/src/media.ts`: ключ подписи из `MEDIA_SIGNING_KEY` в `.env` или из `app_secrets` (генерация 32 байт при первом запуске), `signMediaUrl(file, ttlSec = 43200)` → `/media/<file>?exp=&sig=` (HMAC-SHA256 от `file + exp`), обработчик `GET /media/:file`: находит медиа по `file_name` → маршрут; если у маршрута `price IS NOT NULL` — требует верную непросроченную подпись (сравнение `timingSafeEqual`), иначе 403; отдаёт файл через `reply.sendFile`. В `server/src/app.ts` заменить регистрацию `@fastify/static` с `prefix: '/media/'` на этот обработчик (сохранить `decorateReply` для `sendFile`)
- [ ] T033 [US2] В `server/src/app.ts` добавить `canView(row, viewer)` (владелец, администратор, `route_purchases`, бесплатный публичный) и применить: `fullRoute()` без доступа → превью (`summary`, `price`, `locked: true`, `cover` — первое фото точки как объект `PlacePhoto` с автором, лицензией и ссылкой на источник (принцип IV), `pointCount`, `points: []`, `geometry: null`, без финиша); с доступом к платному — ссылки `url`/`narrationUrl` подписываются `signMediaUrl`; `GET /api/routes/:id/export` и `/suggestions` — 404, `PUT /rating` — 403 без доступа; каталог `GET /api/routes` и `/api/cities` — `price IS NULL OR sale_status = 'approved'` и `deleted_at IS NULL`; в `summary` — `price`, `owned`
- [ ] T034 [US2] Исключить точки маршрутов с `price IS NOT NULL` из `findSharedStory()` в `server/src/app.ts` (и их озвучку из копирования)
- [ ] T035 [US2] В `server/src/money.ts` реализовать `PUT /api/routes/:id/price` (владелец, `requireVerified`; число в `ROUTE_PRICE_MIN…MAX` → `sale_status = 'pending'`, кроме смены цены у `approved` — действует сразу без проверки; `null` → `price = NULL`, `sale_status = NULL`; в маршруте должна быть хотя бы одна точка; цену можно назначить и приватному маршруту) и `POST /api/routes/:id/purchase` (`requireSpender`, `checkExpected`, маршрут `approved` и не удалён, проводка `route_purchase` через `splitShare(price, SALE_COMMISSION_PCT)`, запись `route_purchases` с `price` и `author_share`; ответ — полный маршрут)
- [ ] T036 [US2] Мягкое удаление в `DELETE /api/routes/:id` в `server/src/app.ts`: при наличии `route_purchases` — `deleted_at`, `is_public = 0`, файлы не удаляются; `visibleRoute`/`ownedRoute` для автора — 404, для покупателя — маршрут с `deletedByAuthor: true`; «Мои маршруты» и каталог скрывают удалённые
- [ ] T037 [US2] Обезличивание в `DELETE /api/me` в `server/src/app.ts`: при `available > 0` или открытой заявке без `force: true` → 409 `HAS_POINTS { balance }`; если есть маршруты с покупками — `users.deleted_at`, `email = deleted-<id>@invalid`, `name = 'Удалённый автор'`, пароль и сессии сброшены, маршруты без покупок и их медиа удаляются; иначе — полное удаление, как сейчас. Обновить тест удаления аккаунта в `server/test/features.test.ts`
- [ ] T038 [US2] Очередь проверки в `server/src/admin.ts`: `GET /api/admin/paid-routes?status=pending` (с полным содержимым) и `POST /api/admin/paid-routes/:id/decision` (`approve` | `reject` | `delist`, `note` обязателен для reject/delist; approve → `sale_status = 'approved'` и `is_public = 1` (маршрут публикуется); reject → `is_public = 0`, `price = NULL`; заполнить `sale_decided_at/by`); письмо автору — новая функция `saleDecisionMail(to, name, routeTitle, decision, note, link)` в `server/src/mail.ts`
- [ ] T039 [P] [US2] Клиент `app/src/app/route/[id].tsx` и `app/src/components/RouteCard.tsx`: превью закрытого маршрута (обложка, факты, «Открыть за N баллов» через `PriceConfirm` с текстом «Баллы за открытый маршрут не возвращаются»); для автора — блок «Платный доступ»: цена, статус проверки и причина отказа; предупреждение при удалении и при скрытии (снятии публикации) маршрута с покупателями: «Покупатели сохранят доступ»; значок цены и «Куплен» в карточке; методы `setRoutePrice`, `purchaseRoute` в `app/src/lib/api.ts`
- [ ] T040 [P] [US2] Админка `app/src/app/admin/paid-routes.tsx` (очередь, просмотр содержимого, одобрить/отклонить/снять с причиной), пункт меню в `app/src/app/admin/_layout.tsx`, методы в `app/src/lib/adminApi.ts`

**Checkpoint**: US1 + US2 работают; quickstart 3 проходит

---

## Phase 5: User Story 3 — Поддержка автора премией (P3)

**Goal**: премия автору с маршрута или со страницы автора.

**Independent Test**: quickstart, сценарий 4. Зависит от US1.

### Tests for User Story 3 ⚠️

- [ ] T041 [P] [US3] Тесты премий в `server/test/money.test.ts`: 50 баллов → −50 / +40 / +10; сообщение > 200 символов — 400; сумма вне `TIP_MIN…TIP_MAX` — 400; себе — 400; премия по чужому приватному или закрытому неоткрытому маршруту — 404; история автора показывает имя отправителя, маршрут и сообщение

### Implementation for User Story 3

- [ ] T042 [US3] В `server/src/money.ts` реализовать `POST /api/tips` (`requireSpender`, лимит 30/час, `expectedCost = amount`, маршрут должен быть виден отправителю через `canView`, сообщение — обрезка пробелов, без HTML, ≤ 200, видно только автору и администраторам (FR-022); проводка `tip` через `splitShare(amount, SALE_COMMISSION_PCT)`, запись `tips`) и `GET /api/authors/:id` (имя и публичные маршруты; для обезличенного — «Удалённый автор» без маршрутов)
- [ ] T043 [P] [US3] Компонент `app/src/components/TipSheet.tsx` (суммы 30/50/100 и своя, сообщение до 200 символов, подтверждение через `PriceConfirm`); кнопка «Поддержать автора» на `app/src/app/route/[id].tsx` (нет на своём маршруте); имя автора — ссылка на страницу автора
- [ ] T044 [P] [US3] Страница автора `app/src/app/author/[id].tsx` (регистрация в `app/src/app/_layout.tsx`): имя, список маршрутов (`RouteCard`), «Поддержать автора»; метод `author(id)` и `sendTip` в `app/src/lib/api.ts`

**Checkpoint**: премии работают; quickstart 4 проходит

---

## Phase 6: User Story 4 — Доход и вывод баллов (P3)

**Goal**: пользователь видит доход и выводит любые баллы по заявке с комиссией 5 %.

**Independent Test**: quickstart, сценарий 5. Зависит от US1 (баллы можно купить).

### Tests for User Story 4 ⚠️

- [ ] T045 [P] [US4] Тесты вывода в `server/test/money.test.ts`: квота 1000 баллов при 5 % → к выплате 950 ₽; меньше `PAYOUT_MIN` — 400; вторая открытая заявка — 409; замороженные баллы нельзя потратить (402); «выплачено» → проводка `payout`, письмо; «отклонено» и отзыв пользователем → заморозка снята; комиссия фиксируется при подаче и не меняется при смене настройки; заблокированный — `WALLET_FROZEN`; `DELETE /api/payouts/:id` чужой заявки — 404; не-администратор получает 403 на `GET /api/admin/payouts` и `POST /api/admin/payouts/:id/decision`

### Implementation for User Story 4

- [ ] T046 [US4] В `server/src/money.ts` реализовать `GET /api/payouts/quote`, `POST /api/payouts` (лимит 5/сутки, `requireSpender`, `points ≥ PAYOUT_MIN` и `≤ available`, заморозка `hold(kind 'payout')`, `fee_pct` и `payout_kop` фиксируются), `GET /api/payouts`, `DELETE /api/payouts/:id` (отзыв открытой); `incomeThisMonth` в `GET /api/wallet` — сумма долей автора за календарный месяц по Москве (`monthWindow`)
- [ ] T047 [US4] Админка заявок в `server/src/admin.ts`: `GET /api/admin/payouts?status=open` (с доходом и последними операциями пользователя) и `POST /api/admin/payouts/:id/decision` (`paid` → `capture` заморозки проводкой `payout`: `user −N`, `sys:payouts +N`; `rejected` → `release`; `note` обязателен); письмо — `payoutDecisionMail(...)` в `server/src/mail.ts`
- [ ] T048 [P] [US4] Предупреждение при удалении аккаунта в `app/src/app/(tabs)/profile.tsx`: на `409 HAS_POINTS` показать «На счёте N баллов — они пропадут. Сначала подайте заявку на вывод» с кнопками «Вывести» (переход на `/wallet`) и «Удалить всё равно» (повтор с `force: true`). Блок «Вывод» на `app/src/app/wallet.tsx` (сумма, расчёт «к выплате X ₽, комиссия Y ₽» из `payouts/quote`, статус открытой заявки, отзыв) и раздел «Доход за месяц»; методы в `app/src/lib/api.ts`
- [ ] T049 [P] [US4] Админка `app/src/app/admin/payouts.tsx` (список открытых и закрытых, «Выплачено»/«Отклонить» с комментарием), пункт меню, методы в `app/src/lib/adminApi.ts`

**Checkpoint**: вывод работает; quickstart 5 проходит

---

## Phase 7: User Story 5 — Управление монетизацией (P3)

**Goal**: сводка и сверка денег, журнал, возвраты, цены в настройках.

**Independent Test**: quickstart, сценарий 6.

### Tests for User Story 5 ⚠️

- [ ] T050 [P] [US5] Тесты в `server/test/admin.test.ts`: сводка за период и `reconciled = true` после серии операций; возврат: больше остатка платежа или больше доступного — 400; успешный возврат (`refund.succeeded` через fake) списывает баллы проводкой `refund`, повторное уведомление ничего не меняет; смена цены в настройках действует на следующие операции, прошлые не пересчитываются; не-администратор получает 403 на все `/api/admin/money/*`

### Implementation for User Story 5

- [ ] T051 [US5] В `server/src/admin.ts` реализовать `GET /api/admin/money/summary?from=&to=` (покупки в рублях, выручка генерации, комиссии продаж и премий, комиссии вывода, выплачено, возвраты, остаток баллов у пользователей, `reconciled` + расхождения из `ledger.reconcile`), `GET /api/admin/money/payments`, `GET /api/admin/money/ledger` (фильтры пользователь/тип/период, постранично)
- [ ] T052 [US5] Возвраты: `POST /api/admin/money/payments/:id/refund` в `server/src/admin.ts` (заморозка `hold(kind 'refund')`, запись `refunds`, `gateway.createRefund`), обработка `refund.succeeded`/`canceled` в уведомлениях и в фоновой сверке в `server/src/money.ts` (проводка `refund`: `user −N`, `sys:refunds +N`; `payments.refunded_kop += …`)
- [ ] T053 [US5] Карточка пользователя `GET /api/admin/users/:id` в `server/src/admin.ts`: `wallet`, последние 20 операций, открытая заявка
- [ ] T054 [P] [US5] Админка `app/src/app/admin/money.tsx` (сводка с выбором периода и признаком сверки, платежи, журнал, возврат по платежу), блок счёта в `app/src/app/admin/users/[id].tsx`, пункт меню, методы в `app/src/lib/adminApi.ts`

**Checkpoint**: все истории работают; quickstart 6 проходит

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T055 [P] Экран оферты `app/src/app/offer.tsx` на `LegalPage` (цены и курс баллов, покупка через ЮKassa, вывод любых баллов по заявке с комиссией, отсутствие возврата за открытые маршруты, проверка платных маршрутов, комиссия с продаж и премий, налоги авторов); ссылки на оферту в `app/src/app/terms.tsx` и на экране «Баллы»; раздел о ЮKassa (какие данные передаются, чеки) в `app/src/app/privacy.tsx` — тексты помечены как требующие проверки юристом
- [ ] T056 [P] Обновить `README.md`: раздел «Монетизация» — настройки, подключение ЮKassa (тестовый и боевой магазин, адрес уведомлений, проверка IP), сверка в админке, режим `fake` для разработки
- [ ] T057 [P] Обновить инвентаризацию API в `specs/001-baseline-project/contracts/api-contract.md` ссылкой на `specs/002-monetization/contracts/api.md`
- [ ] T058 Прогнать все проверки: `npm test`, `npm run typecheck`, `npm --prefix app run lint`; пройти сценарии `specs/002-monetization/quickstart.md` 1–8 с `PAYMENTS_PROVIDER=fake`; проверить SC-006: открытие маршрута и премия при достаточном числе баллов — не больше 3 нажатий
- [ ] T059 Проверить на тестовом магазине ЮKassa (нужны shopId и ключ тестового магазина от владельца): оплата тестовой картой, уведомление, чек в личном кабинете, возврат
- [ ] T060 Выкладка (после согласия владельца): внеочередная копия базы `systemctl start rasskazhi-backup.service`, `scripts/deploy.sh`, ключи боевого магазина в админке, адрес уведомлений в личном кабинете ЮKassa; до этого `PAYMENTS_PROVIDER` на сервере пуст

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → истории.
- **US1 (Phase 3)** — после Phase 2; MVP.
- **US2, US3, US4** — после US1 (нужна покупка баллов и `PriceConfirm`); между собой
  независимы. US3 использует `canView` из T033 — если US3 делается раньше US2, T042
  проверяет видимость через существующий `visibleRoute`, а `canView` подключается в US2.
- **US5** — после US1; возвраты (T052) — после T016–T017.
- **Polish** — после нужных историй; T060 — последней.

### Внутри историй

- Тесты истории пишутся первыми и падают.
- Сервер → клиентский API → экраны.
- `server/src/app.ts` и `server/src/money.ts` правятся последовательно (один файл).

## Parallel Opportunities

- Phase 1: T002, T003 параллельно с T001.
- Phase 2: T007, T009, T010 параллельно после T005–T006/T008.
- US1: T013 и T014 параллельно; T025 и T026 (клиент) параллельно с серверными T015–T024.
- US2: T031 параллельно; T039 и T040 (клиент) параллельно с T032–T038.
- US3/US4/US5: клиентские задачи [P] параллельно с серверными; сами истории US2–US5 можно
  вести параллельно разными исполнителями после US1.

### Parallel Example: User Story 1

```text
Сервер: T015 → T016 → T017 → T018; T019 → T020 → T021 → T022 → T023 → T024
Клиент одновременно: T025, T026 → затем T027, T028, T029, T030
Тесты одновременно в начале: T013, T014
```

## Implementation Strategy

### MVP First (только US1)

1. Phase 1 + Phase 2.
2. Phase 3 (US1): покупка баллов и платная генерация.
3. **Стоп и проверка**: quickstart 1, 2, 7; тестовый магазин ЮKassa (T059).
4. Можно выкатить с `PAYMENTS_PROVIDER` пустым (ничего не меняется для пользователей), затем
   включить ЮKassa.

### Incremental Delivery

1. US1 → выкладка → первые платежи.
2. US2 (платные маршруты) → выкладка.
3. US3 (премии) и US4 (вывод) → выкладка.
4. US5 (сводка, возвраты) — желательно до первых выплат авторам.

### Порции для `/speckit-implement`

Рекомендуемые порции: (1) T001–T012; (2) T013–T024; (3) T025–T030; (4) T031–T040;
(5) T041–T049; (6) T050–T058. T059–T060 — только вместе с владельцем.
