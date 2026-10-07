// Count cash by denomination: one box per Philippine peso bill and coin in circulation (BSP New Generation Currency),
// "5 pcs ₱500, 2 pcs ₱1,000 …" → the total. Used wherever the cashier counts real cash — the drawer's opening float,
// cash in / cash out, the closing (blind) count, and the cash received on a sale. The breakdown only helps the cashier
// count; what's saved and synced is still just the total (the drawer/sale payloads don't change).
import { Text, TextInput, View } from 'react-native';

import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { formatPeso } from '../../sale/money';

export interface Denomination {
  key: string;
  /** Face value in centavos (integer arithmetic — no floating-point drift across 1¢ coins). */
  cents: number;
  label: string;
  kind: 'bill' | 'coin';
}

export const PESO_DENOMINATIONS: Denomination[] = [
  { key: 'b1000', cents: 100000, label: '₱1,000', kind: 'bill' },
  { key: 'b500', cents: 50000, label: '₱500', kind: 'bill' },
  { key: 'b200', cents: 20000, label: '₱200', kind: 'bill' },
  { key: 'b100', cents: 10000, label: '₱100', kind: 'bill' },
  { key: 'b50', cents: 5000, label: '₱50', kind: 'bill' },
  { key: 'b20', cents: 2000, label: '₱20', kind: 'bill' },
  { key: 'c20', cents: 2000, label: '₱20', kind: 'coin' },
  { key: 'c10', cents: 1000, label: '₱10', kind: 'coin' },
  { key: 'c5', cents: 500, label: '₱5', kind: 'coin' },
  { key: 'c1', cents: 100, label: '₱1', kind: 'coin' },
  { key: 'c025', cents: 25, label: '25¢', kind: 'coin' },
  { key: 'c005', cents: 5, label: '5¢', kind: 'coin' },
  { key: 'c001', cents: 1, label: '1¢', kind: 'coin' },
];

/** Pieces typed per denomination key, as the cashier typed them (digits only). */
export type DenominationCounts = Record<string, string>;

const MAX_PIECES = 99999;

const pieces = (counts: DenominationCounts, key: string) => {
  const n = Number(counts[key] ?? '');
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** Total in centavos. */
export function denominationTotalCents(counts: DenominationCounts): number {
  return PESO_DENOMINATIONS.reduce((sum, d) => sum + pieces(counts, d.key) * d.cents, 0);
}

/** True once any box has a count. */
export function hasDenominationCounts(counts: DenominationCounts): boolean {
  return PESO_DENOMINATIONS.some((d) => pieces(counts, d.key) > 0);
}

/** The amount-field text for these counts: "2500.00", or '' when nothing is counted. */
export function denominationAmountText(counts: DenominationCounts): string {
  return hasDenominationCounts(counts) ? (denominationTotalCents(counts) / 100).toFixed(2) : '';
}

/** "2 × ₱1,000, 5 × ₱500, 3 × ₱20 coin" — for confirmation prompts. */
export function denominationSummary(counts: DenominationCounts): string {
  return PESO_DENOMINATIONS.filter((d) => pieces(counts, d.key) > 0)
    .map((d) => `${pieces(counts, d.key)} × ${d.label}${d.key === 'c20' ? ' coin' : d.key === 'b20' ? ' bill' : ''}`)
    .join(', ');
}

export function DenominationCounter({
  counts,
  onChange,
  disabled,
  title = 'Count by denomination',
}: {
  counts: DenominationCounts;
  onChange: (next: DenominationCounts) => void;
  disabled?: boolean;
  title?: string;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  const totalCents = denominationTotalCents(counts);

  const setPieces = (key: string, text: string) => {
    const digits = text.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    const capped = digits === '' ? '' : String(Math.min(Number(digits), MAX_PIECES));
    onChange({ ...counts, [key]: capped });
  };

  const group = (kind: Denomination['kind']) => (
    <View style={styles.grid}>
      {PESO_DENOMINATIONS.filter((d) => d.kind === kind).map((d) => {
        const n = pieces(counts, d.key);
        return (
          <View key={d.key} style={[styles.box, n > 0 && { borderColor: c.primary, backgroundColor: c.primarySoft }]}>
            <Text style={styles.face}>{d.label}</Text>
            <View style={styles.inputRow}>
              <TextInput
                value={counts[d.key] ?? ''}
                onChangeText={(t) => setPieces(d.key, t)}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={c.disabled}
                selectTextOnFocus
                editable={!disabled}
                maxLength={5}
                accessibilityLabel={`${d.label} ${d.kind === 'bill' ? 'bills' : 'coins'}, pieces`}
                style={[styles.input, disabled && { backgroundColor: c.surfaceMuted, color: c.disabled }]}
              />
              <Text style={styles.pcs}>pcs</Text>
            </View>
            <Text style={styles.subtotal} numberOfLines={1}>
              {n > 0 ? formatPeso((n * d.cents) / 100) : ' '}
            </Text>
          </View>
        );
      })}
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {hasDenominationCounts(counts) ? (
          <Text style={styles.clear} onPress={disabled ? undefined : () => onChange({})} accessibilityRole="button">
            Clear
          </Text>
        ) : null}
      </View>
      <Text style={styles.groupLabel}>Bills</Text>
      {group('bill')}
      <Text style={styles.groupLabel}>Coins</Text>
      {group('coin')}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total counted</Text>
        <Text style={styles.totalValue}>{formatPeso(totalCents / 100)}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  wrap: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: c.surface,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  title: { ...t.bodyStrong },
  clear: { ...t.label, color: c.primary, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  groupLabel: { ...t.overline, marginTop: spacing.sm, marginBottom: spacing.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  box: {
    width: 104,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  face: { ...t.bodyStrong },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  input: {
    ...t.money,
    width: 60,
    minHeight: 40,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
    textAlign: 'center',
    paddingVertical: 4,
  },
  pcs: { ...t.caption },
  subtotal: { ...t.caption, color: c.textSecondary, marginTop: 2 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  totalLabel: { ...t.bodyStrong },
  totalValue: { ...t.title, fontVariant: ['tabular-nums'] },
}));
