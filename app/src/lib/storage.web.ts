const KEY = 'rasskazhi.token';

export async function loadToken(): Promise<string | null> {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Приватный режим: сессия проживёт до перезагрузки страницы.
  }
}

export async function clearToken(): Promise<void> {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export async function loadSetting(key: string): Promise<string | null> {
  try {
    return localStorage.getItem(`rasskazhi.${key}`);
  } catch {
    return null;
  }
}

export async function saveSetting(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(`rasskazhi.${key}`, value);
  } catch {}
}
