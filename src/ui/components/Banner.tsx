import { useMemo } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { makeStyles, useThemeColors, type ThemeColors } from '../brandTheme';
import { radius, spacing } from '../theme';
import { Button } from './Button';

// An MUI "standard" Alert: soft status background, a status-coloured title, body text in the normal text colour.
export type BannerKind = 'info' | 'success' | 'warning' | 'danger';

export interface BannerProps {
  kind?: BannerKind;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

const tonesOf = (c: ThemeColors): Record<BannerKind, { bg: string; fg: string }> => ({
  info: { bg: c.infoSoft, fg: c.info },
  success: { bg: c.successSoft, fg: c.success },
  warning: { bg: c.warningSoft, fg: c.warning },
  danger: { bg: c.dangerSoft, fg: c.danger },
});

export function Banner({ kind = 'info', title, message, actionLabel, onAction, style }: BannerProps) {
  const styles = useStyles();
  const c = useThemeColors();
  const tones = useMemo(() => tonesOf(c), [c]);
  const t = tones[kind];
  return (
    <View
      accessibilityRole={kind === 'danger' || kind === 'warning' ? 'alert' : undefined}
      style={[styles.banner, { backgroundColor: t.bg }, style]}
    >
      <View style={[styles.mark, { backgroundColor: t.fg }]} />
      <View style={styles.text}>
        {title ? <Text style={[styles.title, { color: t.fg }]}>{title}</Text> : null}
        <Text style={styles.message}>{message}</Text>
      </View>
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} variant="secondary" compact /> : null}
    </View>
  );
}

const useStyles = makeStyles((_c, t) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  mark: { width: 4, alignSelf: 'stretch', borderRadius: radius.pill },
  text: { flex: 1 },
  title: { ...t.bodyStrong },
  message: { ...t.body, fontSize: 14 },
}));
