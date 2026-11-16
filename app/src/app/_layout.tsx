import { setAudioModeAsync } from 'expo-audio';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AuthProvider } from '@/lib/auth';
import { CityProvider } from '@/lib/city';
import { colors, serif } from '@/lib/theme';

export default function RootLayout() {
  useEffect(() => {
    // Экскурсию слушают с телефоном в кармане и с выключенным звонком.
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true }).catch(() => {});
  }, []);

  return (
    <AuthProvider>
      <CityProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.paper },
          headerTintColor: colors.forest,
          headerTitleStyle: { fontFamily: serif, color: colors.ink },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.paper },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="route/[id]" options={{ title: 'Маршрут', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="city" options={{ title: 'Город', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="verify" options={{ title: 'Подтверждение почты', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="admin" options={{ headerShown: false }} />
        <Stack.Screen name="forgot" options={{ title: 'Сброс пароля', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="reset" options={{ title: 'Новый пароль', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="privacy" options={{ title: 'Конфиденциальность', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="terms" options={{ title: 'Условия', headerBackTitle: 'Назад' }} />
      </Stack>
      </CityProvider>
    </AuthProvider>
  );
}
