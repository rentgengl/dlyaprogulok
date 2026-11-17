import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatDuration, pluralStops } from '@/lib/format';
import { colors, radius, serif, space } from '@/lib/theme';
import type { RouteSummary } from '@/lib/types';
import { Stars } from './ui';

export function RouteCard({ route, showVisibility }: { route: RouteSummary; showVisibility?: boolean }) {
  return (
    <Pressable
      role="link"
      onPress={() => router.push(`/route/${route.id}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
    >
      <View style={styles.top}>
        <Text style={styles.title} numberOfLines={2}>
          {route.title}
        </Text>
        {route.price != null ? (
          <View style={[styles.badge, route.owned && styles.badgePublic]}>
            <Text style={[styles.badgeText, route.owned && { color: colors.forest }]}>
              {route.owned ? (showVisibility ? `${route.price} баллов` : 'Куплен') : `${route.price} баллов`}
            </Text>
          </View>
        ) : null}
        {showVisibility ? (
          <View style={[styles.badge, route.isPublic && styles.badgePublic]}>
            <Text style={[styles.badgeText, route.isPublic && { color: colors.forest }]}>
              {route.isPublic ? 'Открыт всем' : 'Только мне'}
            </Text>
          </View>
        ) : null}
      </View>
      {route.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {route.description}
        </Text>
      ) : null}
      <View style={styles.meta}>
        <Meta icon="walk-outline" text={formatDistance(route.distanceM)} />
        <Meta icon="time-outline" text={formatDuration(route.durationMin)} />
        <Meta icon="location-outline" text={pluralStops(route.pointCount)} />
      </View>
      <View style={styles.bottom}>
        {route.rating.count > 0 ? (
          <View style={styles.rating}>
            <Stars value={route.rating.avg ?? 0} size={14} />
            <Text style={styles.small}>
              {String(route.rating.avg).replace('.', ',')} · {route.rating.count}
            </Text>
          </View>
        ) : (
          <Text style={styles.small}>Пока без оценок</Text>
        )}
        <Text style={styles.small} numberOfLines={1}>
          {route.ownerName}
        </Text>
      </View>
    </Pressable>
  );
}

function Meta({ icon, text }: { icon: React.ComponentProps<typeof Ionicons>['name']; text: string }) {
  return (
    <View style={styles.metaItem}>
      <Ionicons name={icon} size={15} color={colors.forest} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.sm,
  },
  top: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', justifyContent: 'space-between' },
  title: { flex: 1, fontFamily: serif, fontSize: 19, lineHeight: 25, fontWeight: '700', color: colors.ink },
  description: { fontSize: 14, lineHeight: 20, color: colors.muted },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  metaText: { fontSize: 14, color: colors.ink },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md, marginTop: space.xs },
  rating: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  small: { fontSize: 13, color: colors.muted, flexShrink: 1 },
  badge: { backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  badgePublic: { backgroundColor: colors.forestSoft },
  badgeText: { fontSize: 12, fontWeight: '600', color: colors.accent },
});
