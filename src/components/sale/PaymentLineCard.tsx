// One tender line: method, amount, reference number (where the method requires one), and for cash the cash received
// with quick amounts, an optional count by denomination, and the change.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { PosPaymentMethod } from '@pos-api/contract';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { radius, shadow, spacing } from '../../ui/theme';
import { cleanDecimalInput, formatPeso, round2 } from '../../sale/money';
import { quickTenders, type PaymentDraft } from '../../sale/payments';
import { Chip } from './ui';
import {
  DenominationCounter,
  denominationAmountText,
  denominationTotalCents,
  hasDenominationCounts,
  type DenominationCounts,
} from './DenominationCounter';

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
  const styles = useStyles();
  const method = methods.find((m) => m.id === line.methodId);
  const isCash = method?.kind === 'CASH';
  const amount = Number(line.amount) || 0;
  const tendered = Number(line.tendered) || 0;
  const change = isCash && line.tendered.trim() !== '' && tendered >= amount ? round2(tendered - amount) : null;
  // Cash received counted by denomination (optional). The counts only fill `tendered`; if it changes any other way
  // (typed, a quick chip, another method), the counts no longer describe it and are dropped.
  const [counting, setCounting] = useState(false);
  const [counts, setCounts] = useState<DenominationCounts>({});
  useEffect(() => {
    if (hasDenominationCounts(counts) && denominationTotalCents(counts) !== Math.round(tendered * 100)) setCounts({});
  }, [tendered, counts]);

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
      {isCash ? (
        <View style={styles.countToggle}>
          <Button
            title={counting ? 'Hide bill count' : 'Count bills and coins'}
            variant="ghost"
            compact
            onPress={() => setCounting((v) => !v)}
            disabled={disabled}
          />
        </View>
      ) : null}
      {isCash && counting ? (
        <DenominationCounter
          counts={counts}
          onChange={(next) => {
            setCounts(next);
            onChange({ tendered: denominationAmountText(next) });
          }}
          disabled={disabled}
          title="Cash received by denomination"
        />
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

const useStyles = makeStyles((c, t) => ({
  card: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: c.surface,
    ...shadow.card,
  },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center', marginBottom: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: { flex: 1, marginBottom: 0 },
  big: { ...t.title, minHeight: 56 },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  countToggle: { flexDirection: 'row', marginTop: spacing.xs, marginBottom: spacing.xs },
  change: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: c.successSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  changeLabel: { ...t.title, color: c.success },
  changeValue: { ...t.display, color: c.success, fontVariant: ['tabular-nums'] },
  error: { ...t.caption, color: c.danger, marginTop: spacing.xs },
}));
