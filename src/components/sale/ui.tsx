// Small building blocks for the selling screens (touch-sized: ≥ 48 dp targets). Brand colours from src/ui/theme.
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, font, radius, spacing } from '../../ui/theme';

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
  const c = tone === 'accent' ? colors.green : tone === 'warning' ? colors.warning : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: c, backgroundColor: selected ? c : colors.surface },
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      <Text style={[styles.chipText, { color: selected ? '#ffffff' : c }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Two or more mutually exclusive options. */
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
            style={[styles.segment, idx > 0 && styles.segmentDivider, on && styles.segmentOn, disabled && { opacity: 0.5 }]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A centred dialog for a landscape tablet. */
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
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['landscape', 'portrait']}>
      <KeyboardAvoidingView behavior="height" style={styles.backdrop}>
        <View style={[styles.sheet, { width, maxWidth: '94%' }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close} hitSlop={8}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.sheetBody} contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SummaryRow({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'muted' | 'danger' | 'success' }) {
  const color = tone === 'muted' ? colors.muted : tone === 'danger' ? colors.danger : tone === 'success' ? colors.success : colors.text;
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, strong && styles.strong, { color }]}>{label}</Text>
      <Text style={[styles.summaryValue, strong && styles.strong, { color }]}>{value}</Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <Text style={styles.error}>{children}</Text>;
}

export function HintText({ children }: { children: ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: font.small + 1, fontWeight: '600' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, overflow: 'hidden' },
  segment: { minHeight: 44, minWidth: 64, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  segmentDivider: { borderLeftWidth: 1, borderLeftColor: colors.primary },
  segmentOn: { backgroundColor: colors.primary },
  segmentText: { fontSize: font.body, fontWeight: '600', color: colors.primary },
  segmentTextOn: { color: '#ffffff' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  sheet: { maxHeight: '92%', backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { flex: 1, fontSize: font.title - 2, fontWeight: '700', color: colors.primary },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 22, color: colors.muted },
  sheetBody: { flexGrow: 0 },
  sheetFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  summaryLabel: { fontSize: font.body },
  summaryValue: { fontSize: font.body, fontVariant: ['tabular-nums'] },
  strong: { fontWeight: '700', fontSize: font.title },
  sectionTitle: { fontSize: font.small, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: spacing.xs, marginTop: spacing.sm },
  error: { color: colors.danger, fontSize: font.small, marginTop: spacing.xs },
  hint: { color: colors.muted, fontSize: font.small, marginTop: spacing.xs },
});
