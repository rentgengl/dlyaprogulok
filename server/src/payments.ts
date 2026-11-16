/**
 * Платёжный шлюз (specs/002-monetization/contracts/yookassa.md): ЮKassa API v3 через fetch и
 * подставной шлюз для разработки и тестов. Сервер доверяет только ответам API, а не телу уведомлений.
 */
import type { PaymentsConfig } from './settings.ts';

export type ProviderStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

export interface ReceiptCfg {
  vatCode: number;
  taxSystem: number;
  paymentMode: string;
  paymentSubject: string;
}

export interface ProviderPayment {
  providerId: string;
  status: ProviderStatus;
  paid: boolean;
  amountKop: number;
  /** Наш id из metadata.payment_id. */
  metadataId?: string;
  cancelReason?: string;
}

export interface ProviderRefund {
  providerId: string;
  status: 'pending' | 'succeeded' | 'canceled';
  paymentProviderId?: string;
  amountKop?: number;
}

export interface PaymentGateway {
  name: 'yookassa' | 'fake';
  createPayment(p: {
    id: string;
    amountKop: number;
    description: string;
    returnUrl: string;
    email: string;
    receipt: ReceiptCfg;
  }): Promise<ProviderPayment & { confirmationUrl: string }>;
  getPayment(providerId: string): Promise<ProviderPayment>;
  createRefund(p: {
    id: string;
    providerPaymentId: string;
    amountKop: number;
    description: string;
    email: string;
    receipt: ReceiptCfg;
  }): Promise<ProviderRefund>;
  getRefund(providerId: string): Promise<ProviderRefund>;
}

/** Ошибка шлюза: текст безопасен для логов (без ключей). */
export class GatewayError extends Error {}

const rub = (kop: number) => (kop / 100).toFixed(2);
const toKop = (value: string) => Math.round(Number(value) * 100);

function receiptBody(email: string, description: string, amountKop: number, r: ReceiptCfg) {
  return {
    customer: { email },
    tax_system_code: r.taxSystem,
    items: [
      {
        description: description.slice(0, 128),
        quantity: '1.00',
        amount: { value: rub(amountKop), currency: 'RUB' },
        vat_code: r.vatCode,
        payment_mode: r.paymentMode,
        payment_subject: r.paymentSubject,
      },
    ],
  };
}

const toPayment = (o: any): ProviderPayment => ({
  providerId: o.id,
  status: o.status,
  paid: !!o.paid,
  amountKop: toKop(o.amount?.value ?? '0'),
  metadataId: o.metadata?.payment_id,
  cancelReason: o.cancellation_details?.reason,
});

const toRefund = (o: any): ProviderRefund => ({
  providerId: o.id,
  status: o.status,
  paymentProviderId: o.payment_id,
  amountKop: o.amount ? toKop(o.amount.value) : undefined,
});

export function createYookassa(cfg: { shopId: string; secretKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): PaymentGateway {
  const base = (cfg.baseUrl ?? 'https://api.yookassa.ru/v3').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString('base64');
  const doFetch = cfg.fetchImpl ?? fetch;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, idempotenceKey?: string): Promise<any> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          ...(idempotenceKey ? { 'Idempotence-Key': idempotenceKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      throw new GatewayError(`ЮKassa недоступна: ${err?.name === 'TimeoutError' ? 'тайм-аут' : (err?.message ?? 'ошибка сети')}`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new GatewayError(`ЮKassa ответила ${res.status}: ${json?.code ?? ''} ${json?.description ?? ''}`.trim());
    }
    return json;
  }

  return {
    name: 'yookassa',
    async createPayment(p) {
      const o = await request(
        'POST',
        '/payments',
        {
          amount: { value: rub(p.amountKop), currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: p.returnUrl },
          description: p.description.slice(0, 128),
          metadata: { payment_id: p.id },
          receipt: receiptBody(p.email, p.description, p.amountKop, p.receipt),
        },
        p.id,
      );
      return { ...toPayment(o), confirmationUrl: o.confirmation?.confirmation_url ?? '' };
    },
    async getPayment(providerId) {
      return toPayment(await request('GET', `/payments/${encodeURIComponent(providerId)}`));
    },
    async createRefund(p) {
      return toRefund(
        await request(
          'POST',
          '/refunds',
          {
            payment_id: p.providerPaymentId,
            amount: { value: rub(p.amountKop), currency: 'RUB' },
            description: p.description.slice(0, 250),
            receipt: receiptBody(p.email, p.description, p.amountKop, p.receipt),
          },
          p.id,
        ),
      );
    },
    async getRefund(providerId) {
      return toRefund(await request('GET', `/refunds/${encodeURIComponent(providerId)}`));
    },
  };
}

/** Подставной шлюз: платежи в памяти; succeed/cancel имитируют действия покупателя. */
export interface FakeGateway extends PaymentGateway {
  succeed(providerId: string, opts?: { amountKop?: number }): void;
  cancel(providerId: string, reason?: string): void;
}

export function createFakeGateway(appUrl: () => string): FakeGateway {
  const payments = new Map<string, ProviderPayment>();
  const refunds = new Map<string, ProviderRefund>();
  const get = (id: string) => {
    const p = payments.get(id);
    if (!p) throw new GatewayError(`Платёж ${id} не найден`);
    return p;
  };
  return {
    name: 'fake',
    async createPayment(p) {
      const providerId = `fake-${p.id}`;
      const existing = payments.get(providerId);
      const payment = existing ?? { providerId, status: 'pending' as const, paid: false, amountKop: p.amountKop, metadataId: p.id };
      payments.set(providerId, payment);
      return { ...payment, confirmationUrl: `${appUrl()}/wallet?payment=${p.id}&fake=1` };
    },
    async getPayment(providerId) {
      return { ...get(providerId) };
    },
    async createRefund(p) {
      const r: ProviderRefund = {
        providerId: `fake-refund-${p.id}`,
        status: 'succeeded',
        paymentProviderId: p.providerPaymentId,
        amountKop: p.amountKop,
      };
      refunds.set(r.providerId, r);
      return { ...r };
    },
    async getRefund(providerId) {
      const r = refunds.get(providerId);
      if (!r) throw new GatewayError(`Возврат ${providerId} не найден`);
      return { ...r };
    },
    succeed(providerId, opts = {}) {
      const p = get(providerId);
      payments.set(providerId, { ...p, status: 'succeeded', paid: true, amountKop: opts.amountKop ?? p.amountKop });
    },
    cancel(providerId, reason = 'canceled_by_merchant') {
      const p = get(providerId);
      payments.set(providerId, { ...p, status: 'canceled', paid: false, cancelReason: reason });
    },
  };
}

export function createGateway(cfg: PaymentsConfig, appUrl: () => string): PaymentGateway | null {
  if (cfg.provider === 'yookassa') return createYookassa({ shopId: cfg.shopId!, secretKey: cfg.secretKey! });
  if (cfg.provider === 'fake') return createFakeGateway(appUrl);
  return null;
}

// Адреса, с которых ЮKassa отправляет уведомления (документация ЮKassa, «Входящие уведомления»).
const YOOKASSA_V4 = ['185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25', '77.75.156.11/32', '77.75.156.35/32', '77.75.154.128/25'];
const YOOKASSA_V6_PREFIX = '2a02:5180:';

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!/^\d+$/.test(part) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
};

export function isYookassaIp(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^::ffff:/, '');
  if (ip.includes(':')) return ip.startsWith(YOOKASSA_V6_PREFIX);
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return YOOKASSA_V4.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const size = 2 ** (32 - Number(bits));
    const start = ipv4ToInt(base!)!;
    return n >= start && n < start + size;
  });
}
