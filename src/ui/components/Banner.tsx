import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, font, radius, spacing } from '../theme';
import { Button } from './Button';

export type BannerKind = 'info' | 'success' | 'warning' | 'danger';

export interface BannerProps {
  kind?: BannerKind;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

const tones: Record<BannerKind, { bg: string; border: string; fg: string }> = {
  info: { bg: '#e8f0f8', border: colors.primary, fg: colors.primary },
  success: { bg: '#eaf4e0', border: colors.success, fg: colors.success },
  warning: { bg: '#fff4d6', border: colors.warning, fg: colors.warning },
  danger: { bg: '#fbe9e7', border: colors.danger, fg: colors.danger },
};

export function Banner({ kind = 'info', title, message, actionLabel, onAction, style }: BannerProps) {
  const t = tones[kind];
  return (
    <View
      accessibilityRole={kind === 'danger' || kind === 'warning' ? 'alert' : undefined}
      style={[styles.banner, { backgroundColor: t.bg, borderColor: t.border }, style]}
    >
      <View style={styles.text}>
        {title ? <Text style={[styles.title, { color: t.fg }]}>{title}</Text> : null}
        <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
      </View>
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} variant="secondary" compact /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderLeftWidth: 5,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  text: { flex: 1 },
  title: { fontSize: font.body, fontWeight: '700' },
  message: { fontSize: font.small },
});
