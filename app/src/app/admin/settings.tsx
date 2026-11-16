import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminPage, adminStyles, Badge, formatDateTime } from '@/components/admin';
import { Banner, Button, Chip, Field, layout } from '@/components/ui';
import { adminApi, type ServicesStatus, type Setting } from '@/lib/adminApi';
import { confirm } from '@/lib/confirm';
import { colors, space } from '@/lib/theme';

const SOURCE: Record<Setting['source'], { text: string; tone: 'good' | 'muted' | 'warn' }> = {
  admin: { text: 'задано в админке', tone: 'good' },
  env: { text: 'из .env', tone: 'muted' },
  default: { text: 'по умолчанию', tone: 'muted' },
};

export default function AdminSettings() {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [services, setServices] = useState<ServicesStatus | null>(null);
  /** Изменённые поля: значение; null — вернуть значение из .env. */
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const accept = (res: { settings: Setting[]; services: ServicesStatus }) => {
    setSettings(res.settings);
    setServices(res.services);
    setDraft({});
  };

  const load = useCallback(async () => {
    try {
      accept(await adminApi.settings());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const groups = useMemo(() => {
    const map = new Map<string, Setting[]>();
    for (const s of settings ?? []) map.set(s.group, [...(map.get(s.group) ?? []), s]);
    return [...map.entries()];
  }, [settings]);

  const changed = Object.keys(draft).length;

  const save = async () => {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      accept(await adminApi.saveSettings(draft));
      setNotice('Сохранено и применено. Перезапуск не нужен.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage>
      <Text style={adminStyles.h1}>Настройки</Text>
      <Text style={layout.muted}>
        Значения из админки перекрывают .env на сервере и применяются сразу. Перед сохранением сервер проверяет, что с новыми
        настройками собираются ИИ, озвучка и почта; при ошибке ничего не меняется. Ключи хранятся в базе на сервере и в
        админке не показываются целиком.
      </Text>
      {services ? (
        <View style={[layout.card, { gap: space.xs }]}>
          <Text style={layout.label}>Сейчас работает</Text>
          <Text style={layout.body}>
            ИИ: {services.ai.provider ? `${services.ai.provider}, ${services.ai.model ?? 'модель по умолчанию'}` : 'выключен'} · Озвучка:{' '}
            {services.tts ?? 'выключена'} · Почта: {services.mailer ?? 'не настроена'} · Лимит:{' '}
            {services.routeMonthlyLimit || 'без ограничения'}
          </Text>
          <View style={adminStyles.inline}>
            <Button
              title="Отправить пробное письмо себе"
              icon="mail-outline"
              variant="secondary"
              disabled={!services.mailer}
              loading={busy === 'mail'}
              onPress={async () => {
                setBusy('mail');
                setError(null);
                setNotice(null);
                try {
                  setNotice(`Письмо отправлено на ${(await adminApi.testMail()).sentTo}`);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            />
          </View>
        </View>
      ) : null}
      {error ? <Banner text={error} /> : null}
      {notice ? <Banner text={notice} tone="info" /> : null}

      {groups.map(([group, items]) => (
        <View key={group} style={layout.card}>
          <Text style={layout.h2}>{group}</Text>
          {items.map((s) => (
            <SettingField
              key={s.key}
              setting={s}
              draft={draft}
              onChange={(value) => setDraft((d) => ({ ...d, [s.key]: value }))}
              onUndo={() =>
                setDraft((d) => {
                  const { [s.key]: _, ...rest } = d;
                  return rest;
                })
              }
            />
          ))}
        </View>
      ))}

      {settings ? (
        <View
          style={[
            adminStyles.inline,
            { position: 'sticky' as never, bottom: 0, paddingVertical: space.md, backgroundColor: colors.paper, borderTopWidth: 1, borderColor: colors.line },
          ]}
        >
          <Button title={changed ? `Сохранить (${changed})` : 'Сохранить'} icon="checkmark" disabled={!changed} loading={busy === 'save'} onPress={save} />
          {changed ? (
            <Button
              title="Отменить правки"
              variant="secondary"
              onPress={async () => {
                if (await confirm('Отменить несохранённые правки?', 'Отменить')) setDraft({});
              }}
            />
          ) : null}
        </View>
      ) : null}
    </AdminPage>
  );
}

function SettingField({
  setting: s,
  draft,
  onChange,
  onUndo,
}: {
  setting: Setting;
  draft: Record<string, string | null>;
  onChange: (value: string | null) => void;
  onUndo: () => void;
}) {
  const touched = s.key in draft;
  const pending = draft[s.key];
  const source = SOURCE[s.source];

  const header = (
    <View style={adminStyles.inline}>
      <Text style={[layout.body, { fontWeight: '600' }]}>{s.label}</Text>
      <Text style={adminStyles.rowMeta}>{s.key}</Text>
      {s.editable ? <Badge text={source.text} tone={source.tone} /> : <Badge text="только в .env" />}
      {touched ? <Badge text={pending === null ? 'вернётся к .env' : 'изменено'} tone="warn" /> : null}
    </View>
  );
  const meta = (
    <>
      {s.help ? <Text style={adminStyles.rowMeta}>{s.help}</Text> : null}
      {s.source === 'admin' && s.updatedAt ? (
        <Text style={adminStyles.rowMeta}>
          Изменено {formatDateTime(s.updatedAt)}
          {s.updatedBy ? `, ${s.updatedBy}` : ''}. В .env: {s.envValue || 'не задано'}.
        </Text>
      ) : null}
    </>
  );
  const undo = touched ? (
    <Text style={adminStyles.link} onPress={onUndo}>
      отменить правку
    </Text>
  ) : s.source === 'admin' ? (
    <Text style={adminStyles.link} onPress={() => onChange(null)}>
      вернуть как в .env
    </Text>
  ) : null;

  if (!s.editable) {
    return (
      <View style={{ gap: space.xs, paddingVertical: space.xs }}>
        {header}
        <Text style={layout.body}>{s.value || '—'}</Text>
        {meta}
      </View>
    );
  }

  let input;
  if (s.kind === 'select') {
    const current = touched && pending !== null ? pending : (s.value ?? '');
    input = (
      <View style={adminStyles.inline}>
        {(s.options ?? []).map((o) => (
          <Chip key={o || 'auto'} label={o || 'автоматически'} active={current === o} onPress={() => onChange(o)} />
        ))}
      </View>
    );
  } else if (s.kind === 'secret') {
    input = (
      <View style={{ gap: space.xs }}>
        <Field
          value={touched && pending !== null ? pending : ''}
          onChangeText={(t) => onChange(t)}
          placeholder={s.masked ? `Задан: ${s.masked}. Введите новый, чтобы заменить` : 'Не задан'}
          secureTextEntry={s.key !== 'SMTP_URL'}
          autoCapitalize="none"
          autoComplete="off"
        />
        {s.isSet && !(touched && pending === '') ? (
          <Text style={adminStyles.link} onPress={() => onChange('')}>
            очистить значение
          </Text>
        ) : null}
        {touched && pending === '' ? <Text style={adminStyles.rowMeta}>Значение будет очищено.</Text> : null}
      </View>
    );
  } else {
    input = (
      <Field
        value={touched && pending !== null ? pending : (s.value ?? '')}
        onChangeText={(t) => onChange(t)}
        keyboardType={s.kind === 'number' ? 'decimal-pad' : 'default'}
        autoCapitalize="none"
        placeholder="Не задано"
      />
    );
  }

  return (
    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
      {header}
      {input}
      {meta}
      {undo}
    </View>
  );
}
