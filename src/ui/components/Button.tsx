import { useMemo } from 'react';
import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';

import { contrastText, makeStyles, useThemeColors, type ThemeColors } from '../brandTheme';
import { radius, spacing } from '../theme';

// MUI-style buttons, like the web app: primary/accent = contained (the main action), secondary = outlined,
// danger = contained error, ghost = text button. `accent` is kept as a name for the big "complete" actions but looks
// like primary — the web app has one action colour.
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

interface Tone {
  bg: string;
  pressedBg: string;
  fg: string;
  border: string;
  /** Contained buttons turn grey when disabled; outlined/text ones only grey their text (and border). */
  contained: boolean;
}

function paletteOf(c: ThemeColors): Record<ButtonVariant, Tone> {
  const contained = (bg: string, pressedBg: string, fg: string): Tone => ({ bg, pressedBg, fg, border: bg, contained: true });
  return {
    primary: contained(c.primary, c.primaryDark, c.onPrimary),
    accent: contained(c.primary, c.primaryDark, c.onPrimary),
    // The error red is fixed, so its text follows the red (white), not the brand's onPrimary.
    danger: contained(c.danger, c.dangerDark, contrastText(c.danger)),
    secondary: { bg: c.surface, pressedBg: c.primarySoftStrong, fg: c.primary, border: c.primary, contained: false },
    ghost: { bg: 'transparent', pressedBg: c.primarySoft, fg: c.primary, border: 'transparent', contained: false },
  };
}

export function Button({ title, onPress, variant = 'primary', disabled, loading, compact, style, accessibilityLabel }: ButtonProps) {
  const styles = useStyles();
  const c = useThemeColors();
  const palette = useMemo(() => paletteOf(c), [c]);
  const p = palette[variant];
  const inactive = !!(disabled || loading);
  const bg = inactive && p.contained ? c.border : p.bg;
  const border = !inactive ? p.border : variant === 'ghost' ? 'transparent' : c.border;
  const fg = inactive ? c.disabled : p.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        { backgroundColor: pressed && !inactive ? p.pressedBg : bg, borderColor: border },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.primary} />
      ) : (
        <Text style={[styles.label, compact && styles.labelCompact, { color: fg }]} numberOfLines={1}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const useStyles = makeStyles((_c, t) => ({
  base: {
    minHeight: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: { minHeight: 36, paddingHorizontal: spacing.md },
  label: { ...t.button },
  labelCompact: { fontSize: 14 },
}));
