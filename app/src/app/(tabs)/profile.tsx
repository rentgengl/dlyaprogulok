import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Banner, Button, Chip, Field, layout } from '@/components/ui';
import { VerifyEmailCard } from '@/components/VerifyEmail';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { quotaText } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import { confirm } from '@/lib/confirm';

export default function ProfileScreen() {
  const { user, ready, signIn, signUp, signOut, refresh, forget } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** После регистрации: ушло ли письмо со ссылкой. */
  const [mailSent, setMailSent] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  /** Удаление аккаунта: открыта ли форма, пароль для подтверждения. */
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  if (!ready) return <View style={layout.screen} />;

  if (user) {
    const quota = quotaText(user.quota);
    return (
      <ScrollView style={layout.screen} contentContainerStyle={layout.content}>
        <VerifyEmailCard
          text={
            mailSent === false
              ? `Письмо на ${user.email} отправить не удалось. Нажмите «Отправить письмо ещё раз» чуть позже.`
              : undefined
          }
        />
        {!user.emailVerified ? (
          <Button
            title="Проверить подтверждение"
            icon="refresh-outline"
            variant="secondary"
            loading={checking}
            onPress={async () => {
              setChecking(true);
              await refresh();
              setChecking(false);
            }}
          />
        ) : null}
        <View style={layout.card}>
          <Text style={layout.h2}>{user.name}</Text>
          <Text style={layout.muted}>
            {user.email}
            {user.emailVerified ? ' · почта подтверждена' : ''}
          </Text>
          {quota ? <Text style={layout.body}>{quota}</Text> : null}
        </View>
        {user.isAdmin ? (
          <Button title="Админка" variant="secondary" icon="settings-outline" onPress={() => router.push('/admin')} />
        ) : null}
        <Button title="Выйти" variant="secondary" icon="log-out-outline" onPress={signOut} />
        {deleting ? (
          <View style={layout.card}>
            <Text style={layout.h2}>Удаление аккаунта</Text>
            <Text style={layout.body}>
              Удалятся профиль, все ваши маршруты (в том числе открытые в каталоге), рассказы, загруженные файлы и оценки.
              Восстановить их будет нельзя.
            </Text>
            <Field
              label="Пароль для подтверждения"
              value={deletePassword}
              onChangeText={setDeletePassword}
              secureTextEntry
              autoComplete="current-password"
            />
            {deleteError ? <Banner text={deleteError} /> : null}
            <View style={layout.row}>
              <Button
                title="Удалить навсегда"
                icon="trash-outline"
                variant="danger"
                loading={busy}
                disabled={!deletePassword}
                onPress={async () => {
                  if (!(await confirm('Удалить аккаунт и все маршруты без возможности восстановления?', 'Удалить'))) return;
                  setBusy(true);
                  setDeleteError(null);
                  try {
                    await api.deleteAccount(deletePassword);
                    await forget();
                    setDeleted(true);
                    setDeleting(false);
                    setDeletePassword('');
                  } catch (err) {
                    setDeleteError(err instanceof ApiError ? err.message : 'Не удалось удалить аккаунт');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <Button title="Отмена" variant="secondary" onPress={() => (setDeleting(false), setDeletePassword(''), setDeleteError(null))} />
            </View>
          </View>
        ) : (
          <Text style={[layout.muted, { textAlign: 'center' }]} onPress={() => setDeleting(true)} role="button">
            Удалить аккаунт
          </Text>
        )}
        <LegalLinks />
      </ScrollView>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await signIn(email, password);
      else setMailSent(await signUp(name, email, password));
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить запрос');
    } finally {
      setBusy(false);
    }
  };

  const incomplete = !email || password.length < 8 || (mode === 'register' && !name.trim());

  return (
    <KeyboardAvoidingView style={layout.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        {deleted ? <Banner tone="info" text="Аккаунт и все ваши данные удалены." /> : null}
        <Text style={layout.h1}>{mode === 'login' ? 'С возвращением' : 'Создайте аккаунт'}</Text>
        <Text style={layout.muted}>Аккаунт нужен, чтобы создавать маршруты и ставить оценки. Смотреть и слушать открытые экскурсии можно и без него.</Text>
        <View style={layout.row}>
          <Chip label="Вход" active={mode === 'login'} onPress={() => setMode('login')} />
          <Chip label="Регистрация" active={mode === 'register'} onPress={() => setMode('register')} />
        </View>
        {mode === 'register' ? (
          <Field label="Имя" value={name} onChangeText={setName} autoComplete="name" />
        ) : null}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
        />
        <Field
          label="Пароль, не короче 8 символов"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onSubmitEditing={() => !incomplete && submit()}
        />
        {error ? <Banner text={error} /> : null}
        <View style={{ marginTop: space.sm }}>
          <Button title={mode === 'login' ? 'Войти' : 'Зарегистрироваться'} onPress={submit} loading={busy} disabled={incomplete} />
        </View>
        {mode === 'login' ? (
          <Text
            style={[layout.muted, { textAlign: 'center', color: colors.forest }]}
            role="link"
            onPress={() => router.push({ pathname: '/forgot', params: email ? { email } : {} })}
          >
            Забыли пароль?
          </Text>
        ) : (
          <Text style={[layout.muted, { textAlign: 'center' }]}>
            Регистрируясь, вы принимаете{' '}
            <Text style={{ color: colors.forest, textDecorationLine: 'underline' }} onPress={() => router.push('/terms')}>
              условия использования
            </Text>{' '}
            и соглашаетесь с{' '}
            <Text style={{ color: colors.forest, textDecorationLine: 'underline' }} onPress={() => router.push('/privacy')}>
              политикой конфиденциальности
            </Text>
            .
          </Text>
        )}
        <LegalLinks />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LegalLinks() {
  return (
    <View style={[layout.row, { justifyContent: 'center', marginTop: space.lg }]}>
      <Text style={[layout.muted, { textDecorationLine: 'underline' }]} role="link" onPress={() => router.push('/privacy')}>
        Политика конфиденциальности
      </Text>
      <Text style={layout.muted}>·</Text>
      <Text style={[layout.muted, { textDecorationLine: 'underline' }]} role="link" onPress={() => router.push('/terms')}>
        Условия использования
      </Text>
    </View>
  );
}
