import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button, Centered, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';

/** Ссылка из письма: dlyaprogulok.ru/verify?token=… */
export default function VerifyScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { ready, user, setUser, refresh } = useAuth();
  const [state, setState] = useState<{ status: 'working' } | { status: 'done' } | { status: 'error'; text: string }>(
    token ? { status: 'working' } : { status: 'error', text: 'В ссылке нет кода подтверждения. Откройте ссылку из письма целиком.' },
  );
  const started = useRef(false);

  useEffect(() => {
    // Ждём восстановления входа: тогда сервер вернёт обновлённый профиль.
    if (!token || !ready || started.current) return;
    started.current = true;
    api
      .verifyEmail(token)
      .then(async (res) => {
        if (res.user) setUser(res.user);
        else await refresh();
        setState({ status: 'done' });
      })
      .catch((err) =>
        setState({ status: 'error', text: err instanceof ApiError ? err.message : 'Не удалось подтвердить почту' }),
      );
  }, [token, ready, setUser, refresh]);

  return (
    <View style={layout.screen}>
      <Stack.Screen options={{ title: 'Подтверждение почты' }} />
      <Centered>
        {state.status === 'working' ? (
          <>
            <ActivityIndicator color={colors.forest} />
            <Text style={layout.body}>Подтверждаем почту…</Text>
          </>
        ) : state.status === 'done' ? (
          <>
            <Ionicons name="checkmark-circle-outline" size={48} color={colors.forest} />
            <Text style={layout.h2}>Почта подтверждена</Text>
            <Text style={[layout.muted, { textAlign: 'center' }]}>
              {user ? 'Теперь можно создавать и публиковать маршруты.' : 'Войдите в аккаунт, чтобы создавать маршруты.'}
            </Text>
            <Button
              title={user ? 'Создать маршрут' : 'Войти'}
              onPress={() => router.replace(user ? '/create' : '/profile')}
            />
          </>
        ) : (
          <>
            <Ionicons name="alert-circle-outline" size={48} color={colors.accent} />
            <Text style={[layout.h2, { textAlign: 'center' }]}>{state.text}</Text>
            <Button title="В профиль" variant="secondary" onPress={() => router.replace('/profile')} />
          </>
        )}
      </Centered>
    </View>
  );
}
