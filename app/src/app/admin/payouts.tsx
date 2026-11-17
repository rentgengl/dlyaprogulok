import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime } from '@/components/admin';
import { Banner, Button, Chip, Field } from '@/components/ui';
import { adminApi, type AdminPayout } from '@/lib/adminApi';
import { confirm } from '@/lib/confirm';
import { space } from '@/lib/theme';

const TABS = [
  { status: 'open', label: 'Открытые' },
  { status: 'paid', label: 'Выплачены' },
  { status: 'rejected', label: 'Отклонены' },
] as const;

const KIND: Record<string, string> = {
  topup: 'покупка',
  charge: 'генерация',
  route_purchase: 'маршрут',
  tip: 'премия',
  payout: 'вывод',
  refund: 'возврат',
};

const rub = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/** Заявки на вывод (FR-024b): перевод делается вне сервиса, здесь — отметка с комментарием. */
export default function AdminPayouts() {
  const [status, setStatus] = useState<(typeof TABS)[number]['status']>('open');
  const [payouts, setPayouts] = useState<AdminPayout[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayouts((await adminApi.payouts(status)).payouts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <AdminPage refreshing={loading} onRefresh={load}>
      <Text style={adminStyles.h1}>Вывод баллов</Text>
      <View style={adminStyles.inline}>
        {TABS.map((t) => (
          <Chip key={t.status} label={t.label} active={status === t.status} onPress={() => setStatus(t.status)} />
        ))}
      </View>
      {error ? <Banner text={error} /> : null}
      {payouts && payouts.length === 0 ? <Text style={adminStyles.rowMeta}>Заявок нет.</Text> : null}
      {payouts?.map((p) => (
        <PayoutRow key={p.id} payout={p} onDone={load} />
      ))}
    </AdminPage>
  );
}

function PayoutRow({ payout: p, onDone }: { payout: AdminPayout; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'paid' | 'rejected') => {
    if (!note.trim()) {
      setError(decision === 'paid' ? 'Добавьте комментарий о переводе' : 'Укажите причину отказа');
      return;
    }
    const question =
      decision === 'paid'
        ? `Отметить выплату ${rub(p.payoutRub)} ₽? Баллы спишутся окончательно.`
        : 'Отклонить заявку? Баллы вернутся пользователю.';
    if (!(await confirm(question, decision === 'paid' ? 'Выплачено' : 'Отклонить'))) return;
    setBusy(decision);
    setError(null);
    try {
      await adminApi.payoutDecision(p.id, decision, note.trim());
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={adminStyles.row}>
      <View style={adminStyles.inline}>
        <Text style={[adminStyles.rowTitle, { flex: 1 }]}>
          {rub(p.payoutRub)} ₽ · {p.points} баллов · комиссия {p.feePct} %
        </Text>
        <Badge text={p.status === 'open' ? 'открыта' : p.status === 'paid' ? 'выплачено' : 'отклонена'} tone={p.status === 'open' ? 'warn' : p.status === 'paid' ? 'good' : 'muted'} />
      </View>
      <Pressable onPress={() => router.push({ pathname: '/admin/users/[id]', params: { id: p.user.id } })}>
        <Text style={adminStyles.link}>
          {p.user.name} · {p.user.email}
        </Text>
      </Pressable>
      <Text style={adminStyles.rowMeta}>
        Подана {formatDateTime(p.createdAt)} · остаток {p.user.balance} · доход от продаж и премий за всё время {p.user.income}
        {p.user.blocked ? ' · заблокирован' : ''}
      </Text>
      {p.recent.length ? (
        <Text style={adminStyles.rowMeta}>
          Последние операции: {p.recent.map((e) => `${KIND[e.kind] ?? e.kind} ${e.amount > 0 ? '+' : ''}${e.amount}`).join(', ')}
        </Text>
      ) : null}
      {p.note ? (
        <Text style={adminStyles.rowMeta}>
          {formatDateTime(p.decidedAt)} · {p.note}
        </Text>
      ) : null}
      {p.status === 'open' ? (
        <View style={{ gap: space.sm }}>
          <Field value={note} onChangeText={setNote} placeholder="Комментарий о переводе или причина отказа — уйдёт пользователю" maxLength={1000} multiline />
          <View style={adminStyles.inline}>
            <Button title="Выплачено" onPress={() => decide('paid')} loading={busy === 'paid'} disabled={!!busy} />
            <Button title="Отклонить" variant="danger" onPress={() => decide('rejected')} loading={busy === 'rejected'} disabled={!!busy} />
          </View>
        </View>
      ) : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}
