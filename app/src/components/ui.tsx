import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { colors, CONTENT_MAX_WIDTH, radius, serif, space } from '@/lib/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function Button({
  title,
  onPress,
  icon,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const fg = variant === 'primary' ? colors.white : variant === 'danger' ? colors.accent : colors.forest;
  return (
    <Pressable
      role="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && { backgroundColor: colors.forest },
        variant === 'secondary' && { backgroundColor: colors.forestSoft },
        variant === 'danger' && { backgroundColor: colors.accentSoft },
        (pressed || disabled) && { opacity: 0.6 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      role="button"
      aria-selected={active}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && { color: colors.white }]}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} {...rest} style={[styles.input, style]} />
    </View>
  );
}

export function Banner({ text, tone = 'error' }: { text: string; tone?: 'error' | 'info' }) {
  return (
    <View style={[styles.banner, tone === 'info' && { backgroundColor: colors.forestSoft }]} role="alert">
      <Text style={{ color: tone === 'info' ? colors.forest : colors.accent, fontSize: 14, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

export function Stars({
  value,
  onChange,
  size = 16,
}: {
  value: number;
  onChange?: (v: number) => void;
  size?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: onChange ? space.sm : 2 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const star = (
          <Ionicons
            key={n}
            name={value >= n - 0.25 ? 'star' : value >= n - 0.75 ? 'star-half' : 'star-outline'}
            size={size}
            color={colors.gold}
          />
        );
        if (!onChange) return star;
        return (
          <Pressable key={n} onPress={() => onChange(n)} role="button" aria-label={`Оценка ${n}`} hitSlop={6}>
            {star}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function Empty({ title, text, icon }: { title: string; text?: string; icon: IconName }) {
  return (
    <Centered>
      <Ionicons name={icon} size={40} color={colors.muted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
    </Centered>
  );
}

export function SignInPrompt({ text }: { text: string }) {
  return (
    <Centered>
      <Ionicons name="person-circle-outline" size={44} color={colors.muted} />
      <Text style={styles.emptyTitle}>Нужен аккаунт</Text>
      <Text style={styles.emptyText}>{text}</Text>
      <Button title="Войти или зарегистрироваться" onPress={() => router.navigate('/profile')} />
    </Centered>
  );
}

export const layout = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', padding: space.lg, gap: space.lg },
  h1: { fontFamily: serif, fontSize: 28, lineHeight: 34, color: colors.ink, fontWeight: '700' },
  h2: { fontFamily: serif, fontSize: 20, lineHeight: 26, color: colors.ink, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
});

const styles = StyleSheet.create({
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  buttonText: { fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  chip: {
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  chipActive: { backgroundColor: colors.forest, borderColor: colors.forest },
  chipText: { color: colors.ink, fontSize: 14, fontWeight: '500' },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
    minHeight: 44,
  },
  banner: { backgroundColor: colors.accentSoft, borderRadius: radius.sm, padding: space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md, minHeight: 280 },
  emptyTitle: { fontFamily: serif, fontSize: 20, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyText: { fontSize: 15, lineHeight: 22, color: colors.muted, textAlign: 'center', maxWidth: 380 },
});
