import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { pluralPoints } from '@/components/PriceConfirm';
import { Banner, Button, Field, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { colors, space } from '@/lib/theme';
import type { Pricing, Route } from '@/lib/types';

const STATUS_TEXT = {
  pending: 'На проверке: маршрут появится в продаже после одобрения администратором.',
  approved: 'В продаже.',
  rejected: 'Отклонён администратором.',
  delisted: 'Снят с продажи администратором. Купившие сохраняют доступ.',
} as const;

/**
 * Блок автора «Платный доступ»: цена, статус проверки, причина отказа (FR-012, FR-012a).
 * Подключается с key = цена: при смене цены форма начинается заново.
 */
export function PaidAccessCard({ route, onRoute }: { route: Route; onRoute: (r: Route) => void }) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [enabled, setEnabled] = useState(route.price != null);
  const [draft, setDraft] = useState(route.price != null ? String(route.price) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pricing().then(setPricing).catch(() => {});
  }, []);

  if (!pricing?.paymentsEnabled && route.price == null) return null;
  const range = pricing?.routePrice;
  const value = Number(draft);
  const valid = !!range && Number.isInteger(value) && value >= range.min && value <= range.max;
  const buyers = route.buyers ?? 0;

  const save = async (price: number | null) => {
    setBusy(true);
    setError(null);
    try {
      onRoute((await api.setRoutePrice(route.id, price)).route);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить цену');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={layout.card}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={layout.body}>Платный доступ</Text>
          <Text style={layout.muted}>
            Без покупки видны только название, описание, факты и обложка. С продажи вы получаете цену за вычетом комиссии
            сервиса{pricing ? ` (${pricing.saleCommissionPct} %)` : ''}.
          </Text>
        </View>
        <Switch
          aria-label="Платный доступ"
          value={enabled}
          trackColor={{ true: colors.forest }}
          disabled={busy}
          onValueChange={(v) => {
            setEnabled(v);
            if (!v && route.price != null) save(null);
          }}
        />
      </View>
      {enabled ? (
        <>
          <Field
            label="Цена в баллах"
            placeholder={range ? `От ${range.min} до ${range.max}` : ''}
            value={draft}
            onChangeText={(t) => setDraft(t.replace(/\D/g, ''))}
            keyboardType="number-pad"
            maxLength={5}
          />
          {draft && !valid && range ? <Text style={styles.warn}>Цена — от {range.min} до {range.max} баллов</Text> : null}
          <Button
            title={route.price == null ? 'Отправить на проверку' : 'Сохранить цену'}
            variant="secondary"
            onPress={() => save(value)}
            loading={busy}
            disabled={!valid || value === route.price}
          />
        </>
      ) : null}
      {route.sale ? (
        <Banner
          tone={route.sale.status === 'rejected' || route.sale.status === 'delisted' ? 'error' : 'info'}
          text={`${STATUS_TEXT[route.sale.status]}${route.sale.note ? ` Причина: ${route.sale.note}` : ''}`}
        />
      ) : null}
      {buyers > 0 ? <Text style={layout.muted}>Открыли: {buyers}</Text> : null}
      {route.price != null ? <Text style={layout.muted}>Текущая цена: {pluralPoints(route.price)}</Text> : null}
      {error ? <Banner text={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  warn: { color: colors.accent, fontSize: 14 },
});
