// Big on-screen number pad for the attendance PIN (4–6 digits). The digits are never shown — only dots.
import { Pressable, Text, View } from 'react-native';

import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';

export const PIN_MIN = 4;
export const PIN_MAX = 6;

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export function PinPad({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  const styles = useStyles();
  const press = (k: (typeof KEYS)[number]) => {
    if (disabled) return;
    if (k === 'clear') onChange('');
    else if (k === 'back') onChange(value.slice(0, -1));
    else if (value.length < PIN_MAX) onChange(value + k);
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.dots} accessibilityLabel={`${value.length} digits entered`}>
        {Array.from({ length: PIN_MAX }, (_, i) => (
          <View key={i} style={[styles.dot, i < value.length && styles.dotFilled, i >= PIN_MIN && i >= value.length && styles.dotOptional]} />
        ))}
      </View>
      <View style={styles.grid}>
        {KEYS.map((k) => (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityLabel={k === 'back' ? 'Delete last digit' : k === 'clear' ? 'Clear' : k}
            disabled={disabled}
            onPress={() => press(k)}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.keyDisabled]}
          >
            <Text style={k === 'clear' || k === 'back' ? styles.keyTextSmall : styles.keyText}>{k === 'back' ? '⌫' : k === 'clear' ? 'Clear' : k}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  wrap: { alignItems: 'center', gap: spacing.lg },
  dots: { flexDirection: 'row', gap: spacing.md, minHeight: 24 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.primary },
  dotFilled: { backgroundColor: c.primary },
  dotOptional: { borderStyle: 'dashed', borderColor: c.borderStrong },
  grid: { width: 300, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'center' },
  key: {
    width: 88,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: c.primarySoftStrong },
  keyDisabled: { opacity: 0.5 },
  keyText: { ...t.title, fontSize: 28 },
  keyTextSmall: { ...t.subtitle },
}));
