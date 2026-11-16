import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, space } from '@/lib/theme';

/** Напоминание подтвердить почту с кнопкой повторной отправки письма. */
export function VerifyEmailCard({ text }: { text?: string }) {
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.resendVerification();
      setUser(res.user);
      setStatus(
        res.sent
          ? { tone: 'ok', text: `Письмо отправлено на ${user.email}. Проверьте и папку «Спам».` }
          : { tone: 'ok', text: 'Почта уже подтверждена.' },
      );
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof ApiError ? err.message : 'Не удалось отправить письмо' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[layout.card, { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft }]} role="alert">
      <Text style={layout.h2}>Подтвердите почту</Text>
      <Text style={layout.body}>
        {text ?? `Мы отправили письмо со ссылкой на ${user.email}.`} Пока почта не подтверждена, нельзя создавать и
        публиковать маршруты и ставить оценки.
      </Text>
      {status ? (
        <Text style={{ color: status.tone === 'ok' ? colors.forest : colors.accent, fontSize: 14, lineHeight: 20 }}>{status.text}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button title="Отправить письмо ещё раз" icon="mail-outline" variant="secondary" loading={busy} onPress={resend} />
      </View>
    </View>
  );
}
