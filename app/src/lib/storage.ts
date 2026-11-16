import * as SecureStore from 'expo-secure-store';

const KEY = 'rasskazhi.token';

export const loadToken = () => SecureStore.getItemAsync(KEY);
export const saveToken = (token: string) => SecureStore.setItemAsync(KEY, token);
export const clearToken = () => SecureStore.deleteItemAsync(KEY);

/** Настройки вроде выбранного города: не секрет, но хранилище то же, лишняя зависимость не нужна. */
export const loadSetting = (key: string) => SecureStore.getItemAsync(`rasskazhi.${key}`).catch(() => null);
export const saveSetting = (key: string, value: string) => SecureStore.setItemAsync(`rasskazhi.${key}`, value).catch(() => {});
