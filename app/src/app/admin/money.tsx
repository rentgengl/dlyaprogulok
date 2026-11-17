import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime, Pager, Stat } from '@/components/admin';
import { Banner, Button, Chip, Field } from '@/components/ui';
import {
  adminApi,
  LEDGER_KIND,
  type AdminLedgerTx,
  type AdminPayment,
  type MoneySummary,
} from '@/lib/adminApi';
import { confirm } from '@/lib/confirm';
import { space } from '@/lib/theme';

const LIMIT = 50;
const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Периоды сводки: текущий и прошлый месяц по Москве, год, всё время. */
function periodOf(kind: string): { from?: string; to?: string } {
  const now = new Date(Date.now() + 3 * 3600_000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const msk = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1) - 3 * 3600_000).toISOString();
  if (kind === 'prev') return { from: msk(y, m - 1), to: msk(y, m) };
  if (kind === 'year') return { from: msk(y, 0), to: msk(y + 1, 0) };
  if (kind === 'all') return { from: '2000-01-01', to: msk(y + 1, 0) };
  return {};
}

const PERIODS = [
  { key: 'month', label: 'Этот месяц' },
  { key: 'prev', label: 'Прошлый месяц' },
  { key: 'year', label: 'Этот год' },
  { key: 'all', label: 'Всё время' },
];

/** Деньги (FR-026–FR-029): сводка со сверкой, платежи ЮKassa с возвратом, журнал операций. */
export default function AdminMoney() {
  const params = useLocalSearchParams<{ user?: string }>();
  const [periodKey, setPeriodKey] = useState('month');
  const [tab, setTab] = useState<'payments' | 'ledger'>('payments');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<MoneySummary | null>(null);
  const [payments, setPayments] = useState<{ total: number; payments: AdminPayment[] } | null>(null);
  const [ledger, setLedger] = useState<{ total: number; items: AdminLedgerTx[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, l] = await Promise.all([
        adminApi.moneySummary(periodOf(periodKey)),
        tab === 'payments' ? adminApi.moneyPayments({ user: params.user, offset, limit: LIMIT }) : Promise.resolve(null),
        tab === 'ledger' ? adminApi.moneyLedger({ user: params.user, kind: kind || undefined, offset, limit: LIMIT }) : Promise.resolve(null),
      ]);
      setSummary(s);
      if (p) setPayments(p);
      if (l) setLedger(l);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [periodKey, tab, kind, offset, params.user]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Деньги</Text>
      <View style={adminStyles.inline}>
        {PERIODS.map((p) => (
          <Chip key={p.key} label={p.label} active={periodKey === p.key} onPress={() => setPeriodKey(p.key)} />
        ))}
      </View>
      {error ? <Banner text={error} /> : null}
      {summary ? (
        <>
          {summary.reconciled ? (
            <Badge text="Учёт сходится" tone="good" />
          ) : (
            <Banner text={`Расхождения в учёте: ${summary.problems.join('; ')}`} />
          )}
          <View style={adminStyles.grid}>
            <Stat label="Покупки баллов" value={rub(summary.purchasesRub)} />
            <Stat label="Выручка генерации" value={rub(summary.generationRevenue)} />
            <Stat label="Комиссия с продаж" value={rub(summary.saleCommission)} />
            <Stat label="Комиссия с премий" value={rub(summary.tipCommission)} />
            <Stat label="Выплачено авторам" value={rub(summary.paidOutRub)} hint={`${summary.payoutPoints} баллов`} />
            <Stat label="Комиссия вывода" value={rub(summary.payoutFeesRub)} />
            <Stat label="Возвраты" value={rub(summary.refundsRub)} />
            <Stat label="Баллы на счетах" value={summary.pointsOnAccounts} hint="сейчас, у всех пользователей" />
          </View>
        </>
      ) : null}

      <View style={adminStyles.inline}>
        <Chip label="Платежи ЮKassa" active={tab === 'payments'} onPress={() => (setTab('payments'), setOffset(0))} />
        <Chip label="Журнал операций" active={tab === 'ledger'} onPress={() => (setTab('ledger'), setOffset(0))} />
        {params.user ? (
          <Pressable onPress={() => router.setParams({ user: undefined })}>
            <Text style={adminStyles.link}>Одного пользователя · показать всех</Text>
          </Pressable>
        ) : null}
      </View>

      {tab === 'payments' && payments ? (
        <>
          {payments.payments.map((p) => (
            <PaymentRow key={p.id} payment={p} onDone={load} />
          ))}
          {payments.payments.length === 0 ? <Text style={adminStyles.rowMeta}>Платежей нет.</Text> : null}
          <Pager offset={offset} limit={LIMIT} total={payments.total} onChange={setOffset} />
        </>
      ) : null}

      {tab === 'ledger' && ledger ? (
        <>
          <View style={adminStyles.inline}>
            <Chip label="Все" active={!kind} onPress={() => (setKind(''), setOffset(0))} />
            {Object.entries(LEDGER_KIND).map(([k, label]) => (
              <Chip key={k} label={label} active={kind === k} onPress={() => (setKind(k), setOffset(0))} />
            ))}
          </View>
          {ledger.items.map((t) => (
            <View key={t.id} style={adminStyles.row}>
              <Text style={adminStyles.rowTitle}>
                {LEDGER_KIND[t.kind] ?? t.kind} · {formatDateTime(t.createdAt)}
              </Text>
              <Text style={adminStyles.rowMeta}>
                {t.entries.map((e) => `${e.account} ${e.amount > 0 ? '+' : ''}${e.amount}`).join(' · ')}
              </Text>
              {t.meta && (t.meta.title || t.meta.routeTitle || t.meta.message) ? (
                <Text style={adminStyles.rowMeta}>
                  {[t.meta.title, t.meta.routeTitle, t.meta.message ? `«${t.meta.message}»` : null].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
            </View>
          ))}
          {ledger.items.length === 0 ? <Text style={adminStyles.rowMeta}>Операций нет.</Text> : null}
          <Pager offset={offset} limit={LIMIT} total={ledger.total} onChange={setOffset} />
        </>
      ) : null}
    </AdminPage>
  );
}

function PaymentRow({ payment: p, onDone }: { payment: AdminPayment; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = p.points - p.refundedRub;

  const refund = async () => {
    const n = Number(points);
    if (!Number.isInteger(n) || n < 1 || n > left) return setError(`Сумма — от 1 до ${left} баллов`);
    if (!note.trim()) return setError('Укажите причину возврата');
    if (!(await confirm(`Вернуть ${n} ₽ через ЮKassa и списать ${n} баллов у пользователя?`, 'Вернуть'))) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.refund(p.id, n, note.trim());
      setOpen(false);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={adminStyles.row}>
      <View style={adminStyles.inline}>
        <Text style={[adminStyles.rowTitle, { flex: 1 }]}>
          {rub(p.amountRub)} · {p.points} баллов
          {p.refundedRub ? ` · возвращено ${rub(p.refundedRub)}` : ''}
        </Text>
        <Badge text={p.status} tone={p.status === 'succeeded' ? 'good' : p.status === 'mismatch' ? 'bad' : 'muted'} />
      </View>
      <Pressable onPress={() => router.push({ pathname: '/admin/users/[id]', params: { id: p.user.id } })}>
        <Text style={adminStyles.link}>
          {p.user.name} · {p.user.email}
        </Text>
      </Pressable>
      <Text style={adminStyles.rowMeta}>
        {formatDateTime(p.createdAt)} · ЮKassa {p.providerId ?? '—'}
        {p.cancelReason ? ` · ${p.cancelReason}` : ''}
      </Text>
      {p.status === 'succeeded' && left > 0 ? (
        open ? (
          <View style={{ gap: space.sm }}>
            <Field label={`Вернуть баллов (до ${left})`} value={points} onChangeText={(t) => setPoints(t.replace(/\D/g, ''))} keyboardType="number-pad" />
            <Field label="Причина" value={note} onChangeText={setNote} maxLength={1000} />
            <View style={adminStyles.inline}>
              <Button title="Вернуть деньги" variant="danger" onPress={refund} loading={busy} />
              <Button title="Отмена" variant="secondary" onPress={() => setOpen(false)} />
            </View>
          </View>
        ) : (
          <Pressable onPress={() => setOpen(true)}>
            <Text style={adminStyles.link}>Оформить возврат</Text>
          </Pressable>
        )
      ) : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}
