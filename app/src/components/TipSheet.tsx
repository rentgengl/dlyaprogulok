import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { pluralPoints, usePriceConfirm } from '@/components/PriceConfirm';
import { Banner, Button, Chip, Field, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { colors, radius, space } from '@/lib/theme';

const PRESETS = [30, 50, 100];

/**
 * Премия автору (FR-018–FR-022): суммы 30/50/100 или своя, сообщение до 200 символов.
 * Кнопка «Поддержать автора» и окно; подтверждение — через PriceConfirm.
 */
export function TipButton({
  authorId,
  authorName,
  routeId,
  onSent,
}: {
  authorId: string;
  authorName: string;
  routeId?: string;
  onSent?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<{ min: number; max: number } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState(50);
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const priceConfirm = usePriceConfirm();

  useEffect(() => {
    api
      .pricing()
      .then((p) => {
        setRange(p.tip);
        setEnabled(p.paymentsEnabled);
      })
      .catch(() => {});
  }, []);

  if (!enabled) return null;
  const chosen = custom.trim() ? Number(custom) : amount;
  const valid = !!range && Number.isInteger(chosen) && chosen >= range.min && chosen <= range.max;

  const send = async () => {
    if (!valid) return;
    setOpen(false);
    setError(null);
    try {
      await priceConfirm.run({
        title: `Премия автору: ${authorName}`,
        cost: chosen,
        note: 'Автор получит премию за вычетом комиссии сервиса.',
        perform: async (expectedCost) => {
          await api.sendTip({ authorId, routeId, amount: chosen, message: message.trim() || undefined, expectedCost });
          setMessage('');
          setCustom('');
          onSent?.(`Спасибо! Премия ${pluralPoints(chosen)} отправлена автору.`);
        },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить премию');
    }
  };

  return (
    <>
      <Button title="Поддержать автора" icon="heart-outline" variant="secondary" onPress={() => setOpen(true)} />
      {error ? <Banner text={error} /> : null}
      <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}} role="dialog" aria-label="Поддержать автора">
            <Text style={layout.h2}>Поддержать автора</Text>
            <Text style={layout.muted}>{authorName}</Text>
            <View style={layout.row}>
              {PRESETS.map((p) => (
                <Chip
                  key={p}
                  label={pluralPoints(p)}
                  active={!custom && amount === p}
                  onPress={() => {
                    setAmount(p);
                    setCustom('');
                  }}
                />
              ))}
            </View>
            <Field
              label="Своя сумма"
              placeholder={range ? `От ${range.min} до ${range.max}` : ''}
              value={custom}
              onChangeText={(t) => setCustom(t.replace(/\D/g, ''))}
              keyboardType="number-pad"
              maxLength={5}
            />
            {custom && !valid && range ? <Text style={styles.warn}>Премия — от {range.min} до {range.max} баллов</Text> : null}
            <Field
              label="Сообщение автору"
              placeholder="Необязательно, до 200 символов"
              value={message}
              onChangeText={setMessage}
              maxLength={200}
              multiline
            />
            <Text style={layout.muted}>Сообщение увидит только автор.</Text>
            <View style={styles.actions}>
              <Button title="Отмена" variant="secondary" onPress={() => setOpen(false)} style={{ flex: 1 }} />
              <Button title={valid ? `Отправить ${chosen}` : 'Отправить'} onPress={send} disabled={!valid} style={{ flex: 1 }} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {priceConfirm.element}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg },
  sheet: { width: '100%', maxWidth: 420, alignSelf: 'center', backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  actions: { flexDirection: 'row', gap: space.sm },
  warn: { color: colors.accent, fontSize: 14 },
});
