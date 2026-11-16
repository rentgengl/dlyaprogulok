import { router } from 'expo-router';
import { Linking, ScrollView, Text, View } from 'react-native';
import { layout } from '@/components/ui';
import { colors, space } from '@/lib/theme';

export interface LegalSection {
  title: string;
  /** Абзацы; строка, начинающаяся с «• », — пункт списка. */
  body: string[];
}

export const CONTACT_EMAIL = 'info@dlyaprogulok.ru';

/** Страница с юридическим текстом: заголовок, дата редакции, разделы. */
export function LegalPage({ title, updated, intro, sections }: { title: string; updated: string; intro: string; sections: LegalSection[] }) {
  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content}>
      <Text style={layout.h1} role="heading" aria-level={1}>
        {title}
      </Text>
      <Text style={layout.muted}>Редакция от {updated}</Text>
      <Text style={layout.body}>{intro}</Text>
      {sections.map((s, i) => (
        <View key={s.title} style={{ gap: space.sm }}>
          <Text style={layout.h2} role="heading" aria-level={2}>
            {i + 1}. {s.title}
          </Text>
          {s.body.map((p, j) =>
            p.startsWith('• ') ? (
              <View key={j} style={{ flexDirection: 'row', gap: space.sm, paddingLeft: space.sm }}>
                <Text style={layout.body}>•</Text>
                <Text style={[layout.body, { flex: 1 }]}>{p.slice(2)}</Text>
              </View>
            ) : (
              <Text key={j} style={layout.body}>
                {p}
              </Text>
            ),
          )}
        </View>
      ))}
      <View style={[layout.card, { marginTop: space.md }]}>
        <Text style={layout.body}>
          Вопросы и запросы:{' '}
          <Text style={{ color: colors.forest, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(`mailto:${CONTACT_EMAIL}`)}>
            {CONTACT_EMAIL}
          </Text>
        </Text>
        <View style={layout.row}>
          <Text style={[layout.muted, { textDecorationLine: 'underline' }]} onPress={() => router.push('/privacy')}>
            Политика конфиденциальности
          </Text>
          <Text style={layout.muted}>·</Text>
          <Text style={[layout.muted, { textDecorationLine: 'underline' }]} onPress={() => router.push('/terms')}>
            Условия использования
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
