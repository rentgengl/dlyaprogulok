import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CAN_BUY_POINTS, pluralPoints } from '@/components/PriceConfirm';
import { Banner, Button, Chip, Field, layout, SignInPrompt } from '@/components/ui';
import { VerifyEmailCard } from '@/components/VerifyEmail';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoscowDate } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import type { LedgerItem, Payment, Pricing, Wallet } from '@/lib/types';

const PRESETS = [100, 300, 500, 1000];
const POLL_MS = 3000;
const POLL_LIMIT_MS = 2 * 60_000;
const FINAL: Payment['status'][] = ['succeeded', 'canceled', 'mismatch'];

const PAYMENT_TEXT: Record<Payment['status'], string> = {
  created: 'Платёж создаётся…',
  pending: 'Ждём подтверждения оплаты…',
  succeeded: 'Оплата прошла, баллы начислены.',
  canceled: 'Платёж отменён, деньги не списаны.',
  mismatch: 'Сумма оплаты не совпала с заказом. Мы разберёмся и свяжемся с вами.',
};

export default function WalletScreen() {
  const { user, ready, refresh } = useAuth();
  const params = useLocalSearchParams<{ payment?: string; fake?: string }>();
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [amount, setAmount] = useState<number>(300);
  const [custom, setCustom] = useState('');
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Платёж, за которым следим: из ссылки возврата или созданный на этом экране. */
  const [paymentId, setPaymentId] = useState<string | null>(params.payment ?? null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [fake, setFake] = useState(params.fake === '1');
  const pollStarted = useRef(0);

  const load = useCallback(async () => {
    try {
      const [p, w, h] = await Promise.all([api.pricing(), api.wallet(), api.walletHistory()]);
      setPricing(p);
      setWallet(w);
      setItems(h.items);
      setNext(h.next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить баллы');
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user?.id, load]);

  useEffect(() => {
    if (params.payment) {
      setPaymentId(params.payment);
      setFake(params.fake === '1');
    }
  }, [params.payment, params.fake]);

  // Опрос статуса до конечного, не дольше 2 минут; заново — при возвращении в приложение после оплаты.
  useEffect(() => {
    if (!paymentId || !user) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    pollStarted.current = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const { payment: p } = await api.getPayment(paymentId);
        if (stopped) return;
        setPayment(p);
        if (FINAL.includes(p.status)) {
          if (p.status === 'succeeded') {
            load();
            refresh();
          }
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setError('Платёж не найден');
          return;
        }
      }
      if (Date.now() - pollStarted.current < POLL_LIMIT_MS) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !stopped) {
        if (timer) clearTimeout(timer);
        pollStarted.current = Date.now();
        tick();
      }
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [paymentId, user?.id, load, refresh]);

  if (!ready) return <View style={layout.screen} />;
  if (!user) {
    return (
      <View style={layout.screen}>
        <SignInPrompt text="Войдите, чтобы увидеть свои баллы." />
      </View>
    );
  }

  const topup = pricing?.topup;
  const customPoints = custom.trim() ? Number(custom.trim()) : null;
  const chosen = customPoints ?? amount;
  const chosenValid = !!topup && Number.isInteger(chosen) && chosen >= topup.min && chosen <= topup.max;

  const buy = async () => {
    if (!chosenValid) return;
    setBuying(true);
    setError(null);
    try {
      const { payment: p } = await api.createPayment(chosen);
      setPayment(p);
      const url = p.confirmationUrl ?? '';
      if (url.includes('fake=1')) {
        // Подставной шлюз разработки: оплата имитируется кнопками на этом же экране.
        setFake(true);
        setPaymentId(p.id);
      } else if (Platform.OS === 'web') {
        globalThis.location.assign(url);
      } else {
        setPaymentId(p.id);
        await Linking.openURL(url);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать платёж');
    } finally {
      setBuying(false);
    }
  };

  const fakeResult = async (result: 'succeeded' | 'canceled') => {
    if (!paymentId) return;
    try {
      const { payment: p } = await api.fakePay(paymentId, result);
      setPayment(p);
      if (p.status === 'succeeded') {
        load();
        refresh();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось');
    }
  };

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const h = await api.walletHistory(next);
      setItems((prev) => [...prev, ...h.items]);
      setNext(h.next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить историю');
    } finally {
      setLoadingMore(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={layout.screen}
      contentContainerStyle={layout.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={layout.card}>
        <Text style={layout.muted}>Доступно</Text>
        {wallet ? (
          <>
            <Text style={styles.balance}>{pluralPoints(wallet.available)}</Text>
            {wallet.frozen > 0 ? <Text style={layout.muted}>Заморожено заявкой на вывод: {pluralPoints(wallet.frozen)}</Text> : null}
            {wallet.reserved > 0 ? <Text style={layout.muted}>Зарезервировано под генерацию: {pluralPoints(wallet.reserved)}</Text> : null}
            <Text style={layout.muted}>1 балл = 1 ₽. Баллами оплачиваются маршруты сверх бесплатного лимита, рассказы и озвучка.</Text>
          </>
        ) : (
          <ActivityIndicator color={colors.forest} />
        )}
      </View>

      {payment && paymentId === payment.id ? (
        <View style={layout.card}>
          <Banner tone={payment.status === 'canceled' || payment.status === 'mismatch' ? 'error' : 'info'} text={`${pluralPoints(payment.points)}: ${PAYMENT_TEXT[payment.status]}`} />
          {fake && !FINAL.includes(payment.status) ? (
            <View style={styles.actions}>
              <Text style={layout.muted}>Тестовый режим оплаты: деньги не списываются.</Text>
              <View style={layout.row}>
                <Button title="Оплатить" onPress={() => fakeResult('succeeded')} />
                <Button title="Отменить" variant="secondary" onPress={() => fakeResult('canceled')} />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {CAN_BUY_POINTS && pricing?.paymentsEnabled ? (
        <View style={layout.card}>
          <Text style={layout.h2}>Купить баллы</Text>
          <VerifyEmailCard />
          <View style={layout.row}>
            {PRESETS.filter((p) => !topup || (p >= topup.min && p <= topup.max)).map((p) => (
              <Chip
                key={p}
                label={`${p}`}
                active={customPoints === null && amount === p}
                onPress={() => {
                  setAmount(p);
                  setCustom('');
                }}
              />
            ))}
          </View>
          <Field
            label="Своя сумма"
            placeholder={topup ? `От ${topup.min} до ${topup.max}` : ''}
            value={custom}
            onChangeText={(t) => setCustom(t.replace(/\D/g, ''))}
            keyboardType="number-pad"
            maxLength={6}
          />
          {custom && !chosenValid && topup ? <Text style={styles.warn}>Сумма от {topup.min} до {topup.max} баллов</Text> : null}
          <Button
            title={chosenValid ? `Оплатить ${chosen} ₽` : 'Оплатить'}
            icon="card-outline"
            onPress={buy}
            loading={buying}
            disabled={!chosenValid || !user.emailVerified}
          />
          <Text style={layout.muted}>
            Оплата через ЮKassa, чек придёт на почту. Покупая баллы, вы принимаете{' '}
            <Text style={styles.link} onPress={() => router.push('/terms')}>
              условия сервиса
            </Text>
            .
          </Text>
        </View>
      ) : null}

      {error ? <Banner text={error} /> : null}

      <View style={{ gap: space.sm }}>
        <Text style={layout.h2}>История</Text>
        {items.length === 0 && wallet ? <Text style={layout.muted}>Операций пока нет.</Text> : null}
        {items.map((i) => (
          <HistoryRow key={i.id} item={i} />
        ))}
        {next ? <Button title="Показать ещё" variant="secondary" onPress={more} loading={loadingMore} /> : null}
      </View>
    </ScrollView>
  );
}

function HistoryRow({ item }: { item: LedgerItem }) {
  const sign = item.amount > 0 ? '+' : '−';
  return (
    <View style={styles.item}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={layout.body}>{item.title}</Text>
        {item.route ? (
          <Pressable onPress={() => router.push({ pathname: '/route/[id]', params: { id: item.route!.id } })}>
            <Text style={styles.link} numberOfLines={1}>
              {item.route.title || 'Маршрут'}
            </Text>
          </Pressable>
        ) : null}
        {item.counterparty ? <Text style={layout.muted}>{item.counterparty.name}</Text> : null}
        {item.message ? <Text style={layout.muted}>«{item.message}»</Text> : null}
        <Text style={layout.muted}>
          {formatMoscowDate(item.createdAt)}
          {item.commission ? ` · комиссия ${pluralPoints(item.commission)}` : ''}
        </Text>
      </View>
      <Text style={[styles.amount, { color: item.amount > 0 ? colors.forest : colors.ink }]}>
        {sign}
        {Math.abs(item.amount)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  balance: { fontSize: 32, lineHeight: 40, fontWeight: '700', color: colors.ink },
  actions: { gap: space.sm, marginTop: space.sm },
  warn: { color: colors.accent, fontSize: 14 },
  link: { color: colors.forest, textDecorationLine: 'underline', fontSize: 14 },
  item: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  amount: { fontSize: 18, fontWeight: '700' },
});
