// A discount as a peso amount or a percentage (₱ / %), for one line or the whole sale. The peso figure shown is the
// shared code's (@shared/discount: an item % is of quantity × price, the sale % of the subtotal after item discounts).
// Any non-zero discount needs a co-signer's code when the sale is completed.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { resolveDiscountAmount } from '@shared/discount';
import { Button, TextField } from '../../ui/components';
import { colors, font, spacing } from '../../ui/theme';
import { cleanDecimalInput, formatPeso, isMoneyText } from '../../sale/money';
import { discountInput, type DiscountDraft, type DiscountMode } from '../../sale/totals';
import { ErrorText, HintText, Segmented, Sheet } from './ui';

export function DiscountDialog({
  visible,
  title,
  base,
  value,
  reason,
  onSave,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** What a percentage is taken of. */
  base: number;
  value: DiscountDraft;
  /** Pass a string to ask for a (required) reason — the transaction discount. */
  reason?: string;
  onSave: (value: DiscountDraft, reason: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DiscountMode>(value.mode);
  const [text, setText] = useState(value.value);
  const [why, setWhy] = useState(reason ?? '');

  useEffect(() => {
    if (!visible) return;
    setMode(value.mode);
    setText(value.value);
    setWhy(reason ?? '');
  }, [visible, value, reason]);

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

  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button
            title="Remove discount"
            variant="ghost"
            onPress={() => {
              onSave({ value: '', mode: 'amount' }, '');
              onClose();
            }}
          />
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
      <View style={styles.row}>
        <Segmented
          options={[
            { value: 'amount', label: '₱ Amount' },
            { value: 'percent', label: '% Percent' },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setText('');
          }}
        />
        <TextField
          value={text}
          onChangeText={(t) => setText(cleanDecimalInput(t))}
          keyboardType="decimal-pad"
          placeholder={mode === 'percent' ? '0 %' : '₱ 0.00'}
          containerStyle={{ flex: 1, marginBottom: 0 }}
          style={styles.bigInput}
          autoFocus
        />
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Text style={styles.result}>
        {pesos > 0 ? `${formatPeso(pesos)} off ${formatPeso(base)}` : `No discount on ${formatPeso(base)}`}
      </Text>
      {reason !== undefined ? (
        <TextField
          label="Reason (required)"
          value={why}
          onChangeText={setWhy}
          placeholder="e.g. Loyal customer promo"
          maxLength={500}
          containerStyle={{ marginTop: spacing.md }}
        />
      ) : null}
      <HintText>A discount needs an approver’s 6-digit code when the sale is completed.</HintText>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bigInput: { fontSize: font.title, minHeight: 52 },
  result: { marginTop: spacing.md, fontSize: font.body, fontWeight: '600', color: colors.primary },
});
