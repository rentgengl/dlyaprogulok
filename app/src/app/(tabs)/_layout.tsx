import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { useCity } from '@/lib/city';
import { colors, serif } from '@/lib/theme';

const icon = (name: ComponentProps<typeof Ionicons>['name']) =>
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} color={color as string} size={size} />;
  };

export default function TabsLayout() {
  const { choice, ready } = useCity();
  // Город — самый первый выбор: без него каталог и создание маршрута не открываются.
  if (!ready) return null;
  if (!choice) return <Redirect href="/city" />;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.paper },
        headerTitleStyle: { fontFamily: serif, color: colors.ink, fontSize: 22 },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.forest,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line },
        sceneStyle: { backgroundColor: colors.paper },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Экскурсии', tabBarIcon: icon('compass-outline') }} />
      <Tabs.Screen name="create" options={{ title: 'Создать', tabBarIcon: icon('sparkles-outline') }} />
      <Tabs.Screen name="mine" options={{ title: 'Мои', tabBarIcon: icon('bookmark-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'Профиль', tabBarIcon: icon('person-outline') }} />
    </Tabs>
  );
}
