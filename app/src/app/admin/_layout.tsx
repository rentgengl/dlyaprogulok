import { Stack } from 'expo-router';
import { View } from 'react-native';
import { Empty, SignInPrompt } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { colors, serif } from '@/lib/theme';

/** Админка: только для администраторов; сервер всё равно проверяет права на каждый запрос. */
export default function AdminLayout() {
  const { user, ready } = useAuth();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.paper }} />;
  if (!user) return <SignInPrompt text="Войдите под аккаунтом администратора." />;
  if (!user.isAdmin) return <Empty icon="lock-closed-outline" title="Нет доступа" text="Админка доступна только администраторам." />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.paper },
        headerTintColor: colors.forest,
        headerTitleStyle: { fontFamily: serif, color: colors.ink },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.paper },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Админка · обзор' }} />
      <Stack.Screen name="routes" options={{ title: 'Админка · маршруты' }} />
      <Stack.Screen name="paid-routes" options={{ title: 'Админка · платные маршруты' }} />
      <Stack.Screen name="payouts" options={{ title: 'Админка · вывод баллов' }} />
      <Stack.Screen name="money" options={{ title: 'Админка · деньги' }} />
      <Stack.Screen name="users/index" options={{ title: 'Админка · пользователи' }} />
      <Stack.Screen name="users/[id]" options={{ title: 'Админка · пользователь' }} />
      <Stack.Screen name="settings" options={{ title: 'Админка · настройки' }} />
    </Stack>
  );
}
