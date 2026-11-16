import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Banner, Button, Field, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { space } from '@/lib/theme';

/** Новый пароль по ссылке из письма: после сохранения пользователь сразу входит. */
export default function ResetScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { adopt } = useAuth();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = repeat.length > 0 && repeat !== password;
  const incomplete = password.length < 8 || repeat !== password;

  const submit = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await adopt(await api.resetPassword(token, password));
      router.replace('/profile');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить пароль');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={layout.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        <Text style={layout.h1}>Новый пароль</Text>
        {!token ? (
          <>
            <Banner text="В ссылке нет кода сброса. Откройте ссылку из письма целиком или запросите новое письмо." />
            <Button title="Запросить письмо" variant="secondary" onPress={() => router.replace('/forgot')} />
          </>
        ) : (
          <>
            <Text style={layout.muted}>После сохранения вы войдёте с новым паролем, а на других устройствах сессии закроются.</Text>
            <Field
              label="Новый пароль, не короче 8 символов"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
            />
            <Field
              label="Повторите пароль"
              value={repeat}
              onChangeText={setRepeat}
              secureTextEntry
              autoComplete="new-password"
              onSubmitEditing={() => !incomplete && submit()}
            />
            {mismatch ? <Text style={layout.muted}>Пароли не совпадают.</Text> : null}
            {error ? <Banner text={error} /> : null}
            {error ? <Button title="Запросить новое письмо" variant="secondary" onPress={() => router.replace('/forgot')} /> : null}
            <View style={{ marginTop: space.sm }}>
              <Button title="Сохранить пароль" icon="checkmark" onPress={submit} loading={busy} disabled={incomplete} />
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
