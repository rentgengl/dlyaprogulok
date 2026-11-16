import { Alert, Platform } from 'react-native';

/** Alert с кнопками на вебе не работает, там нужен window.confirm. */
export function confirm(title: string, action: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(title) ?? false);
  return new Promise((resolve) => {
    Alert.alert(title, undefined, [
      { text: 'Отмена', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}
