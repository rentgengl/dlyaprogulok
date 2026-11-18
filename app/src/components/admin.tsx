import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, serif, space } from '@/lib/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

export const ADMIN_MAX_WIDTH = 1100;

const SECTIONS: { href: string; label: string; icon: IconName }[] = [
  { href: '/admin', label: 'Обзор', icon: 'speedometer-outline' },
  { href: '/admin/routes', label: 'Маршруты', icon: 'map-outline' },
  { href: '/admin/paid-routes', label: 'Проверка', icon: 'pricetag-outline' },
  { href: '/admin/money', label: 'Деньги', icon: 'wallet-outline' },
  { href: '/admin/payouts', label: 'Вывод', icon: 'cash-outline' },
  { href: '/admin/users', label: 'Пользователи', icon: 'people-outline' },
  { href: '/admin/settings', label: 'Настройки', icon: 'options-outline' },
];

/** Каркас страницы админки: разделы сверху, широкая колонка. */
export function AdminPage({
  children,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const path = usePathname();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.paper }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      <View style={styles.nav} role="tablist">
        {SECTIONS.map((s) => {
          const active = s.href === '/admin' ? path === '/admin' : path.startsWith(s.href);
          return (
            <Pressable
              key={s.href}
              role="tab"
              aria-selected={active}
              onPress={() => router.navigate(s.href as never)}
              style={({ pressed }) => [styles.navItem, active && styles.navActive, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name={s.icon} size={16} color={active ? colors.white : colors.forest} />
              <Text style={[styles.navText, active && { color: colors.white }]}>{s.label}</Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => router.navigate('/')} style={styles.navBack} role="link">
          <Text style={styles.navBackText}>На сайт →</Text>
        </Pressable>
      </View>
      {children}
    </ScrollView>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export function Badge({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'good' | 'warn' | 'bad' }) {
  const palette = {
    muted: [colors.line, colors.muted],
    good: [colors.forestSoft, colors.forest],
    warn: ['#F6ECD4', '#8A6516'],
    bad: [colors.accentSoft, colors.accent],
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette[0] }]}>
      <Text style={[styles.badgeText, { color: palette[1] }]}>{text}</Text>
    </View>
  );
}

/** Переключатель «да/нет» с подписью. */
export function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <Pressable role="switch" aria-checked={value} onPress={() => onChange(!value)} style={styles.toggleRow}>
      <View style={[styles.toggle, value && styles.toggleOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const pageNo = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <View style={styles.pager}>
      <PagerButton icon="chevron-back" disabled={offset === 0} onPress={() => onChange(Math.max(0, offset - limit))} />
      <Text style={styles.statLabel}>
        {pageNo} из {pages}
      </Text>
      <PagerButton icon="chevron-forward" disabled={offset + limit >= total} onPress={() => onChange(offset + limit)} />
    </View>
  );
}

function PagerButton({ icon, disabled, onPress }: { icon: IconName; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable role="button" disabled={disabled} onPress={onPress} style={[styles.pagerButton, disabled && { opacity: 0.3 }]}>
      <Ionicons name={icon} size={18} color={colors.forest} />
    </Pressable>
  );
}

export const formatDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const limitText = (u: { routeLimit: number | null }) =>
  u.routeLimit === null ? 'общий лимит' : u.routeLimit === 0 ? 'без лимита' : `свой лимит ${u.routeLimit}`;

export const formatBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} ГБ` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;

export const adminStyles = StyleSheet.create({
  h1: { fontFamily: serif, fontSize: 26, fontWeight: '700', color: colors.ink },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space.md,
    gap: space.xs,
  },
  rowTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  rowMeta: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  link: { color: colors.forest, textDecorationLine: 'underline' },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
});

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: ADMIN_MAX_WIDTH, alignSelf: 'center', padding: space.lg, gap: space.lg },
  nav: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    minHeight: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  navActive: { backgroundColor: colors.forest, borderColor: colors.forest },
  navText: { fontSize: 14, fontWeight: '600', color: colors.forest },
  navBack: { marginLeft: 'auto', padding: space.sm },
  navBackText: { color: colors.muted, fontSize: 14 },
  stat: {
    flexGrow: 1,
    flexBasis: 160,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space.lg,
    gap: 2,
  },
  statValue: { fontFamily: serif, fontSize: 28, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 14, color: colors.ink },
  statHint: { fontSize: 12, color: colors.muted, lineHeight: 16 },
  badge: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: colors.line, padding: 2 },
  toggleOn: { backgroundColor: colors.forest },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.white },
  knobOn: { transform: [{ translateX: 18 }] },
  toggleLabel: { fontSize: 15, color: colors.ink },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md },
  pagerButton: { padding: space.sm, borderRadius: radius.pill, backgroundColor: colors.forestSoft },
});
