// Small building blocks for the selling screens (touch-sized: ≥ 44–48 dp targets), styled like the web app's MUI
// components. Colours and text styles come from src/ui/theme — never hardcode them here.
import { useMemo, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { makeStyles, useThemeColors, type ThemeColors } from '../../ui/brandTheme';
import { radius, shadow, spacing } from '../../ui/theme';
import { markTillActivity } from '../../auth/tillLock';

type ChipTone = 'primary' | 'accent' | 'warning';

// Selected: filled in the tone's colour with white text (warning stays a soft tint — it flags, it isn't chosen).
// `accent` reads as the brand secondary green.
const chipTonesOf = (c: ThemeColors): Record<ChipTone, { fg: string; soft: string; filled: boolean }> => ({
  primary: { fg: c.primary, soft: c.primary, filled: true },
  accent: { fg: c.secondary, soft: c.secondary, filled: true },
  warning: { fg: c.warning, soft: c.warningSoft, filled: false },
});

export function Chip({
  label,
  selected,
  onPress,
  disabled,
  tone = 'primary',
  style,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'accent' | 'warning';
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  const chipTones = useMemo(() => chipTonesOf(c), [c]);
  const t = chipTones[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        selected ? { borderColor: t.fg, backgroundColor: t.soft } : styles.chipIdle,
        pressed && { backgroundColor: selected ? (t.filled ? c.primaryDark : c.primarySoftStrong) : c.primarySoft },
        disabled && styles.chipDisabled,
        style,
      ]}
    >
      <Text
        style={[
          styles.chipText,
          selected && styles.chipTextOn,
          { color: disabled ? c.disabled : selected ? (t.filled ? c.onPrimary : t.fg) : c.text },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Two or more mutually exclusive options (an MUI ToggleButtonGroup). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  return (
    <View style={styles.segmented}>
      {options.map((o, idx) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              styles.segment,
              idx > 0 && styles.segmentDivider,
              on && styles.segmentOn,
              pressed && !on && { backgroundColor: c.primarySoft },
            ]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn, disabled && { color: c.disabled }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A centred dialog for a landscape tablet (an MUI Dialog). */
/** Counts a touch for the till's idle lock (src/auth/tillLock.ts) without taking the touch. */
export function tillTouch(): boolean {
  markTillActivity();
  return false;
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
  width = 620,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['landscape', 'portrait']}>
      {/* A Modal is its own native window: its touches never reach App.tsx's root view — count them for the idle lock here. */}
      <KeyboardAvoidingView behavior="height" style={styles.backdrop} onStartShouldSetResponderCapture={tillTouch}>
        <View style={[styles.sheet, { width, maxWidth: '94%' }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && { backgroundColor: c.onPrimaryPressed }]}
              hitSlop={8}
            >
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SummaryRow({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'muted' | 'danger' | 'success' }) {
  const styles = useStyles();
  const c = useThemeColors();
  const color = tone === 'muted' ? c.muted : tone === 'danger' ? c.danger : tone === 'success' ? c.success : c.text;
  return (
    <View style={[styles.summaryRow, strong && styles.summaryRowStrong]}>
      <Text style={[styles.summaryLabel, strong && styles.strongLabel, { color }]}>{label}</Text>
      <Text style={[styles.summaryValue, strong && styles.strongValue, { color }]}>{value}</Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.error}>{children}</Text>;
}

export function HintText({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.hint}>{children}</Text>;
}

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

const badgeTonesOf = (c: ThemeColors): Record<BadgeTone, { bg: string; fg: string }> => ({
  success: { bg: c.successSoft, fg: c.success },
  warning: { bg: c.warningSoft, fg: c.warning },
  danger: { bg: c.dangerSoft, fg: c.danger },
  info: { bg: c.infoSoft, fg: c.info },
  neutral: { bg: c.surfaceMuted, fg: c.muted },
  primary: { bg: c.primarySoftStrong, fg: c.primary },
});

/** A small status label (MUI Chip size="small"): soft background, strong text. */
export function StatusBadge({ label, tone = 'neutral', style }: { label: string; tone?: BadgeTone; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  const c = useThemeColors();
  const badgeTones = useMemo(() => badgeTonesOf(c), [c]);
  const t = badgeTones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.badgeText, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** One choice in a grid of people/options (approver, Sold By): an outlined tile with a radio mark, tinted when chosen. */
export function OptionTile({
  label,
  selected,
  onPress,
  disabled,
  style,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        selected && styles.tileOn,
        pressed && !selected && { backgroundColor: c.primarySoft },
        disabled && styles.chipDisabled,
        style,
      ]}
    >
      <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
      <Text style={[styles.tileText, selected && styles.tileTextOn, disabled && { color: c.disabled }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c, t) => ({
  chip: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipIdle: { borderColor: c.border, backgroundColor: c.surface },
  chipDisabled: { backgroundColor: c.surfaceMuted, borderColor: c.border },
  chipText: { ...t.subtitle, fontSize: 14 },
  chipTextOn: { fontFamily: t.bodyStrong.fontFamily },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.surface,
  },
  // flexGrow: fills the width when the group is stretched (in a column), content width otherwise (in a row).
  segment: { flexGrow: 1, minHeight: 44, minWidth: 64, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  segmentDivider: { borderLeftWidth: 1, borderLeftColor: c.borderStrong },
  segmentOn: { backgroundColor: c.primary },
  segmentText: { ...t.subtitle, fontSize: 14, color: c.muted },
  segmentTextOn: { color: c.onPrimary, fontFamily: t.bodyStrong.fontFamily },
  backdrop: { flex: 1, backgroundColor: c.backdrop, alignItems: 'center', justifyContent: 'center' },
  sheet: { maxHeight: '92%', backgroundColor: c.surface, borderRadius: radius.lg, overflow: 'hidden', ...shadow.sheet },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.xl,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: c.primary,
  },
  sheetTitle: { ...t.heading, flex: 1, color: c.onPrimary },
  close: { width: 44, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  closeText: { ...t.body, fontSize: 20, color: c.onPrimary },
  sheetBody: { flexGrow: 0 },
  sheetContent: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
  sheetFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: c.primaryTintBorder,
    backgroundColor: c.primaryTint,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  summaryRowStrong: { marginTop: spacing.xs, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: c.border },
  summaryLabel: { ...t.body },
  summaryValue: { ...t.money, fontFamily: t.body.fontFamily },
  strongLabel: { ...t.title },
  strongValue: { ...t.money, fontSize: t.title.fontSize },
  sectionTitle: { ...t.overline, marginBottom: spacing.xs, marginTop: spacing.md },
  error: { ...t.caption, color: c.danger, marginTop: spacing.xs },
  hint: { ...t.caption, marginTop: spacing.xs },
  badge: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: spacing.sm + 2, paddingVertical: 3 },
  badgeText: { ...t.caption, fontSize: 12, fontFamily: t.bodyStrong.fontFamily },
  tile: {
    width: '48%',
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: c.surface,
  },
  tileOn: { borderColor: c.primary, backgroundColor: c.primarySoft },
  tileText: { ...t.subtitle, flex: 1 },
  tileTextOn: { color: c.primary, fontFamily: t.bodyStrong.fontFamily },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: c.primary },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: c.primary },
}));
