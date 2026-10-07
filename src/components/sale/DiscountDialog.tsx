// A discount as a peso amount or a percentage (₱ / %), for one line or the whole sale. The peso figure shown is the
// shared code's (@shared/discount: an item % is of quantity × price, the sale % of the subtotal after item discounts).
// Any non-zero discount needs a co-signer's code when the sale is completed.
//
// Layout — ONE column at every width (never the switch and the field side by side: on a landscape tablet that squeezed
// the field until the typed amount was hidden to the right of the % tab), same for the item and the sale discount:
//   1. ₱ Amount / % Percent switch — its own full-width row
//   2. the amount / percentage field — its own full-width row (focused when the sheet opens)
//   3. the live estimate ("= ₱5.00 off · ₱45.00 after") or the validation error, right under the field
//   4. Reason (sale discount only), directly under the field + estimate
//   5. the figures box (before → discount → after, "Before VAT")
//   6. the notes and the approver-code hint
// Cancel/Remove + Apply live in the Sheet's footer — outside the scrolling body, so the keyboard or a long reason never
// pushes them off-screen. The field sits near the top of the body, so it stays in view with the keyboard up.
import { useEffect, useRef, useState } from 'react';
import { Text, type TextInput, View } from 'react-native';
import { resolveDiscountAmount } from '@shared/discount';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { cleanDecimalInput, formatPeso, isMoneyText } from '../../sale/money';
import { discountInput, hasDiscount, type DiscountDraft, type DiscountMode } from '../../sale/totals';
import { ErrorText, HintText, Segmented, Sheet } from './ui';

export function DiscountDialog({
  visible,
  title,
  base,
  baseLabel,
  value,
  reason,
  notes,
  onSave,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** What a percentage is taken of. */
  base: number;
  /** What `base` is ("Line subtotal", "Subtotal after item discounts") — shown with the before → after figures. */
  baseLabel: string;
  value: DiscountDraft;
  /** Pass a string to ask for a (required) reason — the transaction discount. */
  reason?: string;
  /** Rules the cashier should keep in view (already enforced elsewhere — shown, not re-checked here). */
  notes?: string[];
  onSave: (value: DiscountDraft, reason: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [mode, setMode] = useState<DiscountMode>(value.mode);
  const [text, setText] = useState(value.value);
  const [why, setWhy] = useState(reason ?? '');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setMode(value.mode);
    setText(value.value);
    setWhy(reason ?? '');
  }, [visible, value, reason]);

  // autoFocus alone is unreliable inside a Modal that is still fading in on Android — focus again once it's shown.
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(id);
  }, [visible]);

  const draft: DiscountDraft = { value: text, mode };
  const pesos = resolveDiscountAmount(base, discountInput(draft));
  const error =
    text.trim() === ''
      ? null
      : !isMoneyText(text)
        ? 'Use a number with at most 2 decimal places.'
        : mode === 'percent' && Number(text) > 100
          ? 'A percentage can’t be more than 100%.'
          : pesos > base + 0.0001
            ? `The discount can’t be more than ${formatPeso(base)}.`
            : null;
  const needsReason = reason !== undefined && pesos > 0 && why.trim() === '';
  const canSave = error === null && !needsReason && why.trim().length <= 500;
  const hadDiscount = hasDiscount(value);
  const after = Math.max(base - pesos, 0);

  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={onClose}
      width={520}
      footer={
        <>
          {hadDiscount ? (
            <Button
              title="Remove discount"
              variant="ghost"
              onPress={() => {
                onSave({ value: '', mode: 'amount' }, '');
                onClose();
              }}
            />
          ) : (
            <Button title="Cancel" variant="ghost" onPress={onClose} />
          )}
          <Button
            title="Apply"
            disabled={!canSave}
            onPress={() => {
              onSave(pesos > 0 ? draft : { value: '', mode: 'amount' }, pesos > 0 ? why.trim() : '');
              onClose();
            }}
          />
        </>
      }
    >
      {/* 1 — the ₱ / % switch, alone on its row (a column parent stretches it; its segments grow to fill). */}
      <View style={styles.switchRow}>
        <Segmented
          options={[
            { value: 'amount', label: '₱ Amount' },
            { value: 'percent', label: '% Percent' },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setText('');
            inputRef.current?.focus();
          }}
        />
      </View>

      {/* 2 — the amount / percentage, alone on its full-width row. */}
      <TextField
        ref={inputRef}
        label={mode === 'percent' ? `Percentage off (of ${formatPeso(base)})` : `Amount off (up to ${formatPeso(base)})`}
        value={text}
        onChangeText={(t) => setText(cleanDecimalInput(t))}
        keyboardType="decimal-pad"
        placeholder={mode === 'percent' ? '0 %' : '₱ 0.00'}
        containerStyle={styles.field}
        style={styles.bigInput}
        accessibilityLabel={mode === 'percent' ? 'Discount percentage' : 'Discount in pesos'}
        autoFocus
      />
      {/* 3 — the live estimate (or the error), directly under the field. */}
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : pesos > 0 ? (
        <Text style={styles.estimate} numberOfLines={2}>
          = {formatPeso(pesos)} off{mode === 'percent' ? ` (${text.trim()}%)` : ''} · {formatPeso(after)} after
        </Text>
      ) : (
        <Text style={styles.estimateIdle}>{mode === 'percent' ? 'Type a percentage from 0 to 100.' : 'Type the peso amount to take off.'}</Text>
      )}

      {/* 4 — the reason (sale discount only), right under the field. */}
      {reason !== undefined ? (
        <TextField
          label="Reason (required)"
          value={why}
          onChangeText={setWhy}
          placeholder="e.g. Loyal customer promo"
          maxLength={500}
          containerStyle={styles.reason}
          error={needsReason ? 'Enter the reason to apply this discount.' : null}
        />
      ) : null}

      {/* 5 — before → discount → after. */}
      <View style={styles.figures}>
        <View style={styles.figureRow}>
          <Text style={styles.figureLabel}>{baseLabel}</Text>
          <Text style={styles.figureValue}>{formatPeso(base)}</Text>
        </View>
        <View style={styles.figureRow}>
          <Text style={styles.figureLabel}>Discount{mode === 'percent' && pesos > 0 ? ` (${text.trim()}%)` : ''}</Text>
          <Text style={[styles.figureValue, pesos > 0 && styles.figureOff]}>{pesos > 0 ? formatPeso(-pesos) : '—'}</Text>
        </View>
        <View style={[styles.figureRow, styles.figureAfterRow]}>
          <Text style={styles.afterLabel}>After discount</Text>
          <Text style={styles.afterValue}>{formatPeso(after)}</Text>
        </View>
        <Text style={styles.figureNote}>Before VAT — VAT is added on top.</Text>
      </View>

      {/* 6 — rules to keep in view. */}
      {(notes ?? []).map((n) => (
        <HintText key={n}>{n}</HintText>
      ))}
      <HintText>A discount needs an approver’s 6-digit code when the sale is completed.</HintText>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  // A column: the Segmented group is stretched to the full width and its segments (flexGrow) fill it.
  switchRow: { flexDirection: 'column', alignItems: 'stretch', marginBottom: spacing.md },
  field: { alignSelf: 'stretch', marginBottom: 0 },
  bigInput: { ...t.title, minHeight: 52, alignSelf: 'stretch' },
  estimate: { ...t.bodyStrong, color: c.success, marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
  estimateIdle: { ...t.caption, marginTop: spacing.xs },
  reason: { alignSelf: 'stretch', marginTop: spacing.md, marginBottom: 0 },
  figures: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
    backgroundColor: c.primaryTint,
  },
  figureRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, paddingVertical: 2 },
  figureLabel: { ...t.body, flexShrink: 1 },
  figureValue: { ...t.money, fontFamily: t.body.fontFamily },
  figureOff: { color: c.success },
  figureAfterRow: { marginTop: spacing.xs, paddingTop: spacing.xs, borderTopWidth: 1, borderTopColor: c.primaryTintBorder },
  afterLabel: { ...t.bodyStrong, color: c.primary, flexShrink: 1 },
  afterValue: { ...t.money, color: c.primary },
  figureNote: { ...t.caption, fontSize: 12, marginTop: 2 },
}));
