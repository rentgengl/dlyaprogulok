# Контракт интеграции: ЮKassa (API v3)

Модуль `server/src/payments.ts`, интерфейс:

```ts
interface PaymentGateway {
  name: string;                                        // 'yookassa' | 'fake'
  createPayment(p: { id: string; amountKop: number; description: string;
    returnUrl: string; email: string; receipt: ReceiptCfg }): Promise<{ providerId: string;
    status: ProviderStatus; confirmationUrl: string }>;
  getPayment(providerId: string): Promise<{ status: ProviderStatus; paid: boolean;
    amountKop: number; metadataId?: string; cancelReason?: string }>;
  createRefund(p: { id: string; providerPaymentId: string; amountKop: number;
    email: string; receipt: ReceiptCfg }): Promise<{ providerId: string;
    status: 'pending' | 'succeeded' | 'canceled' }>;
}
type ProviderStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
```

## Вызовы

Базовый адрес `https://api.yookassa.ru/v3`, Basic-auth `YOOKASSA_SHOP_ID:YOOKASSA_SECRET_KEY`,
тайм-аут 15 с, заголовок `Idempotence-Key` = наш id платежа/возврата (повтор запроса после
сбоя сети не создаёт второй платёж).

| Наш вызов | HTTP | Ключевые поля |
|---|---|---|
| createPayment | `POST /payments` | `amount: { value: "300.00", currency: "RUB" }`, `capture: true`, `confirmation: { type: "redirect", return_url }`, `description`, `metadata: { payment_id }`, `receipt: { customer: { email }, tax_system_code, items: [{ description, quantity: "1.00", amount, vat_code, payment_mode, payment_subject }] }` |
| getPayment | `GET /payments/{id}` | `status`, `paid`, `amount`, `metadata.payment_id`, `cancellation_details.reason` |
| createRefund | `POST /refunds` | `payment_id`, `amount`, `receipt` (та же позиция, сумма возврата) |

Ошибки ЮKassa (4xx) логируются с `code`/`description` из ответа; пользователю — «Не удалось
создать платёж, попробуйте позже», `502`. Секретный ключ в логах не появляется.

## Уведомления

`POST /api/payments/yookassa/notify`, настраивается в личном кабинете ЮKassa на
`https://dlyaprogulok.ru/api/payments/yookassa/notify`, события: `payment.succeeded`,
`payment.canceled`, `refund.succeeded`.

Обработка:
1. Если `YOOKASSA_CHECK_IP=1` — IP источника (с учётом `TRUST_PROXY`) должен входить в
   список диапазонов ЮKassa (хранится в коде; обновляется по документации ЮKassa), иначе `403`.
2. Тело используется только как подсказка: берётся `object.id`, далее `getPayment` /
   получение возврата из API. Статус из API применяется к нашему платежу, найденному по
   `provider_id`.
3. Применение статуса идемпотентно: `succeeded` начисляет баллы одной транзакцией
   (`UPDATE payments SET status='succeeded' … WHERE id=? AND status IN ('created','pending')`
   + проводка `topup`); повторное уведомление ничего не меняет.
4. Ответ всегда `200` (ЮKassa повторяет уведомления при любом другом ответе), ошибки — в лог.
5. Сумма из API сверяется с `payments.amount_kop`; расхождение — платёж помечается
   `mismatch`, баллы не начисляются, событие пишется в лог для администратора.

## Сверка

- `GET /api/payments/:id` при `pending` — `getPayment` не чаще раза в 5 с на платёж.
- Фоновая сверка каждые 10 минут: платежи `pending` моложе 24 ч и возвраты `pending`.
- Платежи `created`/`pending` старше 24 ч помечаются `canceled` (ЮKassa отменяет
  неоплаченные платежи сама; сверка подтверждает это через `getPayment`).

## Fake-шлюз (разработка и тесты)

`PAYMENTS_PROVIDER=fake`: `createPayment` возвращает `confirmationUrl =
${APP_URL}/wallet?payment=<id>&fake=1`; экран «Баллы» в режиме разработки показывает кнопки
«Оплатить» / «Отменить», которые вызывают `POST /api/dev/fake-payments/:id` (`succeeded` или
`canceled`). Endpoint регистрируется только при `fake`. В production `fake` запрещён
(сервер не запускается при `NODE_ENV=production` и `PAYMENTS_PROVIDER=fake`).
