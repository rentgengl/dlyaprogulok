import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime, Toggle } from '@/components/admin';
import { Banner, Button, Chip, Field, layout } from '@/components/ui';
import { adminApi, LEDGER_KIND, type AdminLedgerEntry, type AdminUser, type AdminWallet, type UserPatch } from '@/lib/adminApi';
import { useAuth } from '@/lib/auth';
import { confirm } from '@/lib/confirm';
import { formatDistance, formatMoscowDate, pluralStops } from '@/lib/format';
import type { PayoutRequest, RouteSummary } from '@/lib/types';
import { space } from '@/lib/theme';

type LimitMode = 'default' | 'custom' | 'none';

export default function AdminUserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user: me } = useAuth();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Черновик формы.
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [verified, setVerified] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [limitMode, setLimitMode] = useState<LimitMode>('default');
  const [limit, setLimit] = useState('');
  const [password, setPassword] = useState('');
  const [money, setMoney] = useState<{ wallet: AdminWallet; ledger: AdminLedgerEntry[]; payout: PayoutRequest | null } | null>(null);

  const fill = (u: AdminUser) => {
    setUser(u);
    setName(u.name);
    setEmail(u.email);
    setVerified(u.emailVerified);
    setAdmin(u.isAdmin);
    setBlocked(u.blocked);
    setLimitMode(u.routeLimit === null ? 'default' : u.routeLimit === 0 ? 'none' : 'custom');
    setLimit(u.routeLimit ? String(u.routeLimit) : '');
    setPassword('');
  };

  const load = useCallback(async () => {
    try {
      const res = await adminApi.user(id);
      fill(res.user);
      setRoutes(res.routes);
      setMoney({ wallet: res.wallet, ledger: res.ledger, payout: res.payout });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const run = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!user) {
    return <AdminPage>{error ? <Banner text={error} /> : <Text style={layout.muted}>Загрузка…</Text>}</AdminPage>;
  }

  const self = me?.id === user.id;
  const routeLimit = limitMode === 'default' ? null : limitMode === 'none' ? 0 : Number(limit);
  const limitInvalid = limitMode === 'custom' && !(Number.isInteger(routeLimit) && (routeLimit as number) > 0);

  const patch: UserPatch = {};
  if (name.trim() !== user.name) patch.name = name.trim();
  if (email.trim().toLowerCase() !== user.email) patch.email = email.trim();
  if (verified !== user.emailVerified) patch.emailVerified = verified;
  if (admin !== user.isAdmin) patch.isAdmin = admin;
  if (blocked !== user.blocked) patch.blocked = blocked;
  if (!limitInvalid && routeLimit !== user.routeLimit) patch.routeLimit = routeLimit;
  if (password) patch.password = password;
  const dirty = Object.keys(patch).length > 0;

  const quota = user.quota;
  return (
    <AdminPage>
      <View style={adminStyles.inline}>
        <Text style={adminStyles.h1}>{user.name}</Text>
        {user.isAdmin ? <Badge text="админ" tone="good" /> : null}
        {user.blocked ? <Badge text={`заблокирован ${formatDateTime(user.blockedAt)}`} tone="bad" /> : null}
        {self ? <Badge text="это вы" /> : null}
      </View>
      <Text style={adminStyles.rowMeta}>
        id {user.id} · зарегистрирован {formatDateTime(user.createdAt)} · активных сессий: {user.activeSessions}
      </Text>
      {error ? <Banner text={error} /> : null}
      {notice ? <Banner text={notice} tone="info" /> : null}

      {money ? (
        <View style={layout.card}>
          <Text style={layout.h2}>Счёт</Text>
          <Text style={layout.body}>
            Остаток {money.wallet.balance} · доступно {money.wallet.available}
            {money.wallet.frozen ? ` · заморожено ${money.wallet.frozen}` : ''}
            {money.wallet.reserved ? ` · в резерве ${money.wallet.reserved}` : ''}
          </Text>
          {money.payout ? (
            <Pressable onPress={() => router.push('/admin/payouts')}>
              <Text style={adminStyles.link}>
                Открытая заявка на вывод: {money.payout.points} баллов, к выплате {money.payout.payoutRub} ₽
              </Text>
            </Pressable>
          ) : null}
          {money.ledger.map((e) => (
            <Text key={e.id} style={adminStyles.rowMeta}>
              {formatDateTime(e.createdAt)} · {LEDGER_KIND[e.kind] ?? e.kind} · {e.amount > 0 ? '+' : ''}
              {e.amount}
              {typeof e.meta?.routeTitle === 'string' ? ` · ${e.meta.routeTitle}` : ''}
              {typeof e.meta?.message === 'string' ? ` · «${e.meta.message}»` : ''}
            </Text>
          ))}
          {money.ledger.length === 0 ? <Text style={adminStyles.rowMeta}>Операций нет.</Text> : null}
          <Pressable onPress={() => router.push({ pathname: '/admin/money', params: { user: user.id } })}>
            <Text style={adminStyles.link}>Платежи и журнал пользователя</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={layout.card}>
        <Text style={layout.h2}>Профиль</Text>
        <Field label="Имя" value={name} onChangeText={setName} maxLength={60} />
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <Toggle label="Почта подтверждена" value={verified} onChange={setVerified} />
        <Toggle
          label="Администратор"
          value={admin}
          onChange={setAdmin}
          hint={self ? 'Снять права с себя нельзя: попросите другого администратора.' : 'Полный доступ к админке, всем маршрутам и настройкам.'}
        />
        <Toggle
          label="Заблокирован"
          value={blocked}
          onChange={setBlocked}
          hint="Не может войти; все сессии закрываются сразу. Маршруты остаются."
        />
        <Field
          label="Новый пароль"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Оставьте пустым, чтобы не менять"
          autoComplete="new-password"
        />
      </View>

      <View style={layout.card}>
        <Text style={layout.h2}>Месячный лимит маршрутов</Text>
        {quota ? (
          <Text style={layout.body}>
            В этом месяце создано {quota.used}
            {quota.limit ? ` из ${quota.limit}` : ', лимита нет'}. Счётчик обнулится {formatMoscowDate(quota.resetsAt)}.
          </Text>
        ) : null}
        <View style={adminStyles.inline}>
          <Chip label="Общий из настроек" active={limitMode === 'default'} onPress={() => setLimitMode('default')} />
          <Chip label="Свой" active={limitMode === 'custom'} onPress={() => setLimitMode('custom')} />
          <Chip label="Без ограничения" active={limitMode === 'none'} onPress={() => setLimitMode('none')} />
        </View>
        {limitMode === 'custom' ? (
          <View style={{ maxWidth: 200 }}>
            <Field label="Маршрутов в месяц" value={limit} onChangeText={(t) => setLimit(t.replace(/\D/g, ''))} keyboardType="number-pad" />
          </View>
        ) : null}
        {limitInvalid ? <Text style={adminStyles.rowMeta}>Укажите число больше нуля.</Text> : null}
        <View style={adminStyles.inline}>
          <Button
            title="Обнулить счётчик этого месяца"
            icon="refresh-outline"
            variant="secondary"
            loading={busy === 'quota'}
            disabled={!quota?.used}
            onPress={() =>
              run('quota', async () => {
                fill((await adminApi.resetQuota(user.id)).user);
                return 'Счётчик обнулён';
              })
            }
          />
        </View>
      </View>

      <View style={adminStyles.inline}>
        <Button
          title="Сохранить"
          icon="checkmark"
          disabled={!dirty || limitInvalid}
          loading={busy === 'save'}
          onPress={() =>
            run('save', async () => {
              fill((await adminApi.updateUser(user.id, patch)).user);
              return 'Сохранено';
            })
          }
        />
        {dirty ? <Button title="Отменить правки" variant="secondary" onPress={() => fill(user)} /> : null}
        <Button
          title="Завершить все сессии"
          icon="log-out-outline"
          variant="secondary"
          loading={busy === 'logout'}
          disabled={!user.activeSessions}
          onPress={() =>
            run('logout', async () => {
              const { closed } = await adminApi.logoutUser(user.id);
              await load();
              return `Закрыто сессий: ${closed}${self ? '. Вам придётся войти снова.' : ''}`;
            })
          }
        />
        {!self ? (
          <Button
            title="Удалить пользователя"
            icon="trash-outline"
            variant="danger"
            loading={busy === 'delete'}
            onPress={async () => {
              const ok = await confirm(
                `Удалить ${user.email} вместе со всеми маршрутами (${user.routeCount}), оценками и файлами? Это нельзя отменить.`,
                'Удалить',
              );
              if (!ok) return;
              run('delete', async () => {
                await adminApi.deleteUser(user.id);
                router.replace('/admin/users');
              });
            }}
          />
        ) : null}
      </View>

      <View style={{ gap: space.sm }}>
        <View style={adminStyles.inline}>
          <Text style={layout.h2}>Маршруты · {routes.length}</Text>
          {routes.length ? (
            <Text style={adminStyles.link} onPress={() => router.push(`/admin/routes?owner=${user.id}`)}>
              управлять в списке маршрутов
            </Text>
          ) : null}
        </View>
        {routes.length === 0 ? <Text style={layout.muted}>Маршрутов нет.</Text> : null}
        {routes.map((r) => (
          <View key={r.id} style={adminStyles.row}>
            <View style={adminStyles.inline}>
              <Text style={[adminStyles.rowTitle, adminStyles.link]} onPress={() => router.push(`/route/${r.id}`)}>
                {r.title}
              </Text>
              {r.isPublic ? <Badge text="в каталоге" tone="good" /> : <Badge text="скрыт" />}
            </View>
            <Text style={adminStyles.rowMeta}>
              {[r.city, r.start.label].filter(Boolean).join(', ')} · {pluralStops(r.pointCount)}, {formatDistance(r.distanceM)} · создан{' '}
              {formatDateTime(r.createdAt)}
            </Text>
          </View>
        ))}
      </View>
    </AdminPage>
  );
}
