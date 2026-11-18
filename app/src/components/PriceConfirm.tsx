import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, radius, space } from '@/lib/theme';

/** Покупка баллов в приложении для iOS не показывается (App Store 3.1.1). */
export const CAN_BUY_POINTS = Platform.OS !== 'ios';

export function pluralPoints(n: number): string {
  const d10 = Math.abs(n) % 10;
  const d100 = Math.abs(n) % 100;
  if (d10 === 1 && d100 !== 11) return `${n} балл`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} балла`;
  return `${n} баллов`;
}

export interface PaidAction {
  /** Что покупается: «Подбор маршрута на 2 ч». */
  title: string;
  /** Цена по оценке сервера. */
  cost: number;
  /** Пояснение под ценой, например про оплату озвучки по факту. */
  note?: string;
  /** Выполняет действие с подтверждённой ценой; ошибки PRICE_CHANGED и INSUFFICIENT_POINTS обработает окно. */
  perform: (expectedCost: number) => Promise<void>;
}

type State =
  | { phase: 'closed' }
  | {
      phase: 'confirm';
      action: PaidAction;
      cost: number;
      available: number | null;
      busy: boolean;
      changed: boolean;
      shortBy: number | null;
      error: string | null;
    };

/**
 * Подтверждение платного действия (FR-005): цена, доступно, остаток после списания.
 * run(action) с нулевой ценой выполняет действие сразу, без окна.
 */
export function usePriceConfirm() {
  const { refresh } = useAuth();
  const [state, setState] = useState<State>({ phase: 'closed' });

  const close = useCallback(() => setState({ phase: 'closed' }), []);

  const run = useCallback(
    async (action: PaidAction) => {
      let cost = action.cost;
      let changed = false;
      if (cost <= 0) {
        try {
          await action.perform(0);
          return;
        } catch (err) {
          // Оценка устарела (например, лимит закончился): действие платное — спрашиваем цену.
          if (!(err instanceof ApiError && err.code === 'PRICE_CHANGED' && typeof err.body.cost === 'number')) throw err;
          cost = err.body.cost;
          changed = true;
        }
      }
      setState({ phase: 'confirm', action, cost, available: null, busy: false, changed, shortBy: null, error: null });
      try {
        const w = await api.wallet();
        setState((s) => (s.phase === 'confirm' && s.action === action ? { ...s, available: w.available } : s));
      } catch {
        // Остаток не узнали — цену всё равно можно подтвердить, сервер проверит сам.
      }
    },
    [],
  );

  const confirm = async () => {
    if (state.phase !== 'confirm') return;
    const { action, cost } = state;
    setState({ ...state, busy: true, error: null });
    try {
      await action.perform(cost);
      setState({ phase: 'closed' });
      refresh();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e?.code === 'PRICE_CHANGED' && typeof e.body.cost === 'number') {
        setState({ ...state, cost: e.body.cost, busy: false, changed: true, shortBy: null, error: null });
      } else if (e?.code === 'INSUFFICIENT_POINTS') {
        const need = Number(e.body.need ?? cost);
        const avail = Number(e.body.available ?? 0);
        setState({ ...state, available: avail, busy: false, shortBy: Math.max(1, need - avail), error: null });
      } else {
        setState({ ...state, busy: false, error: err instanceof Error ? err.message : 'Не удалось выполнить' });
      }
    }
  };

  const element =
    state.phase === 'confirm' ? (
      <Modal transparent animationType="fade" visible onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={state.busy ? undefined : close}>
          <Pressable style={styles.sheet} onPress={() => {}} role="dialog" aria-label="Подтверждение цены">
            <Text style={layout.h2}>{state.action.title}</Text>
            {state.changed ? <Banner tone="info" text={`Цена изменилась: ${pluralPoints(state.cost)}. Подтвердите ещё раз.`} /> : null}
            <View style={styles.rows}>
              <Row label="Цена" value={pluralPoints(state.cost)} strong />
              <Row
                label="Доступно"
                value={state.available === null ? <ActivityIndicator size="small" color={colors.muted} /> : pluralPoints(state.available)}
              />
              {state.available !== null && state.available >= state.cost ? (
                <Row label="Останется" value={pluralPoints(state.available - state.cost)} />
              ) : null}
            </View>
            {state.action.note ? <Text style={layout.muted}>{state.action.note}</Text> : null}
            {state.error ? <Banner text={state.error} /> : null}
            {state.shortBy !== null || (state.available !== null && state.available < state.cost) ? (
              <>
                <Banner
                  text={
                    CAN_BUY_POINTS
                      ? `Не хватает ${pluralPoints(state.shortBy ?? state.cost - (state.available ?? 0))}.`
                      : 'Недостаточно баллов.'
                  }
                />
                {CAN_BUY_POINTS ? (
                  <Button
                    title="Купить баллы"
                    icon="wallet-outline"
                    onPress={() => {
                      close();
                      router.push('/wallet');
                    }}
                  />
                ) : null}
                <Button title="Закрыть" variant="secondary" onPress={close} />
              </>
            ) : (
              <View style={styles.actions}>
                <Button title="Отмена" variant="secondary" onPress={close} disabled={state.busy} style={{ flex: 1 }} />
                <Button title="Подтвердить" onPress={confirm} loading={state.busy} style={{ flex: 1 }} />
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    ) : null;

  return { run, element };
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={layout.muted}>{label}</Text>
      {typeof value === 'string' ? <Text style={[layout.body, strong && { fontWeight: '700' }]}>{value}</Text> : value}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg },
  sheet: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  rows: { gap: space.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: space.sm },
});
