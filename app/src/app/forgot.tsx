import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Banner, Button, Field, layout } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { space } from '@/lib/theme';

/** Запрос письма для сброса пароля. */
export default function ForgotScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить запрос');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={layout.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        <Text style={layout.h1}>Сброс пароля</Text>
        {sentTo ? (
          <Banner
            tone="info"
            text={`Если адрес ${sentTo} зарегистрирован, мы отправили на него письмо со ссылкой для нового пароля. Ссылка действует час. Письма нет — проверьте папку «Спам».`}
          />
        ) : (
          <>
            <Text style={layout.muted}>Укажите почту, с которой регистрировались: пришлём ссылку, чтобы задать новый пароль.</Text>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              onSubmitEditing={() => email.includes('@') && submit()}
            />
            {error ? <Banner text={error} /> : null}
            <View style={{ marginTop: space.sm }}>
              <Button title="Отправить ссылку" icon="mail-outline" onPress={submit} loading={busy} disabled={!email.includes('@')} />
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
