// One tender line: method, amount, reference number (where the method requires one), and for cash the cash received
// with quick amounts and the change.
import { StyleSheet, Text, View } from 'react-native';
import type { PosPaymentMethod } from '@pos-api/contract';
import { Button, TextField } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';
import { cleanDecimalInput, formatPeso, round2 } from '../../sale/money';
import { quickTenders, type PaymentDraft } from '../../sale/payments';
import { Chip } from './ui';

export function PaymentLineCard({
  line,
  methods,
  error,
  cashTaken,
  onChange,
  onRemove,
  disabled,
}: {
  line: PaymentDraft;
  methods: PosPaymentMethod[];
  error: string | null;
  /** Another line already pays in cash (one cash line per sale). */
  cashTaken: boolean;
  onChange: (patch: Partial<PaymentDraft>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const method = methods.find((m) => m.id === line.methodId);
  const isCash = method?.kind === 'CASH';
  const amount = Number(line.amount) || 0;
  const tendered = Number(line.tendered) || 0;
  const change = isCash && line.tendered.trim() !== '' && tendered >= amount ? round2(tendered - amount) : null;

  return (
    <View style={styles.card}>
      <View style={styles.methods}>
        {methods.map((m) => (
          <Chip
            key={m.id}
            label={m.name}
            selected={m.id === line.methodId}
            onPress={() => onChange({ methodId: m.id, tendered: '' })}
            disabled={disabled || (m.kind === 'CASH' && cashTaken && !isCash)}
          />
        ))}
        <View style={{ flex: 1 }} />
        <Button title="Remove" variant="ghost" compact onPress={onRemove} disabled={disabled} />
      </View>
      <View style={styles.row}>
        <TextField
          label={line.auto ? 'Amount (follows what’s left to pay)' : 'Amount'}
          value={line.amount}
          onChangeText={(t) => onChange({ amount: cleanDecimalInput(t), auto: false })}
          keyboardType="decimal-pad"
          selectTextOnFocus
          style={styles.big}
          containerStyle={styles.cell}
          editable={!disabled}
        />
        {method && (method.requires_reference || !isCash) ? (
          <TextField
            label={method.requires_reference ? 'Reference no. (required)' : 'Reference no. (optional)'}
            value={line.reference}
            onChangeText={(t) => onChange({ reference: t })}
            maxLength={64}
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.big}
            containerStyle={styles.cell}
            editable={!disabled}
          />
        ) : null}
        {isCash ? (
          <TextField
            label="Cash received (required)"
            value={line.tendered}
            onChangeText={(t) => onChange({ tendered: cleanDecimalInput(t) })}
            keyboardType="decimal-pad"
            selectTextOnFocus
            style={styles.big}
            containerStyle={styles.cell}
            editable={!disabled}
          />
        ) : null}
      </View>
      {isCash && amount > 0 ? (
        <View style={styles.quick}>
          {quickTenders(amount).map((v) => (
            <Chip
              key={v}
              label={v === round2(amount) ? `Exact ${formatPeso(v)}` : formatPeso(v)}
              selected={line.tendered.trim() !== '' && Number(line.tendered) === v}
              onPress={() => onChange({ tendered: v.toFixed(2) })}
              disabled={disabled}
            />
          ))}
        </View>
      ) : null}
      {change !== null ? (
        <View style={styles.change}>
          <Text style={styles.changeLabel}>Change</Text>
          <Text style={styles.changeValue}>{formatPeso(change)}</Text>
        </View>
      ) : null}
      {error && line.amount.trim() !== '' ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, backgroundColor: colors.surface },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center', marginBottom: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: { flex: 1, marginBottom: 0 },
  big: { fontSize: font.title, minHeight: 56 },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  change: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.success,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  changeLabel: { color: '#fff', fontSize: font.title, fontWeight: '700' },
  changeValue: { color: '#fff', fontSize: font.huge, fontWeight: '800' },
  error: { color: colors.danger, fontSize: font.small, marginTop: spacing.xs },
});
