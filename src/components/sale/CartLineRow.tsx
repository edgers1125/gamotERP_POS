// One cart line: name, price, − qty +, item discount, line total and the stock hint ("will be Oversold" when the
// online stock check says the shelf can't cover it — the sale is still recorded, stock is decided at sync).
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius, spacing } from '../../ui/theme';
import type { CartLine } from '../../sale/cart';
import { formatPeso } from '../../sale/money';
import { hasDiscount } from '../../sale/totals';

export function CartLineRow({
  line,
  itemDiscountAmount,
  statutory,
  available,
  onQuantity,
  onDiscount,
  onRemove,
  disabled,
}: {
  line: CartLine;
  itemDiscountAmount: number;
  /** This line gets the Senior/PWD 20% (no item discount allowed). */
  statutory: boolean;
  /** Unexpired on-shelf units (online hint), undefined when unknown. */
  available: number | undefined;
  onQuantity: (q: number) => void;
  onDiscount: () => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [qtyText, setQtyText] = useState(String(line.quantity));
  useEffect(() => setQtyText(String(line.quantity)), [line.quantity]);
  const subtotal = line.quantity * line.unitPrice;
  const short = available !== undefined && line.quantity > available;

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={2}>
            {line.name}
          </Text>
          <Text style={styles.meta}>
            {formatPeso(line.unitPrice)} each · {line.skuCode}
            {line.isVatable ? '' : ' · non-VAT'}
          </Text>
        </View>
        <Text style={styles.amount}>{formatPeso(subtotal)}</Text>
      </View>
      <View style={styles.bottom}>
        <Pressable accessibilityLabel="Decrease quantity" style={styles.qtyBtn} onPress={() => onQuantity(line.quantity - 1)} disabled={disabled || line.quantity <= 1}>
          <Text style={[styles.qtyBtnText, line.quantity <= 1 && { color: colors.border }]}>−</Text>
        </Pressable>
        <TextInput
          value={qtyText}
          onChangeText={(t) => setQtyText(t.replace(/\D/g, '').slice(0, 5))}
          onEndEditing={() => onQuantity(Number(qtyText) || 1)}
          keyboardType="number-pad"
          selectTextOnFocus
          style={styles.qtyInput}
          editable={!disabled}
          accessibilityLabel="Quantity"
        />
        <Pressable accessibilityLabel="Increase quantity" style={styles.qtyBtn} onPress={() => onQuantity(line.quantity + 1)} disabled={disabled}>
          <Text style={styles.qtyBtnText}>+</Text>
        </Pressable>

        {statutory ? (
          <Text style={styles.sc}>SC/PWD 20%</Text>
        ) : (
          <Pressable onPress={onDiscount} disabled={disabled} style={[styles.discBtn, hasDiscount(line.discount) && styles.discBtnOn]}>
            <Text style={[styles.discText, hasDiscount(line.discount) && { color: '#fff' }]}>
              {hasDiscount(line.discount)
                ? `− ${formatPeso(itemDiscountAmount)}${line.discount.mode === 'percent' ? ` (${line.discount.value}%)` : ''}`
                : 'Discount'}
            </Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityLabel={`Remove ${line.name}`} onPress={onRemove} disabled={disabled} style={styles.remove}>
          <Text style={styles.removeText}>Remove</Text>
        </Pressable>
      </View>
      {short ? (
        <Text style={styles.short}>
          {available! <= 0 ? 'Out of stock' : `Only ${available} on the shelf`} — this sale will be recorded as Oversold.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  top: { flexDirection: 'row', gap: spacing.sm },
  name: { fontSize: font.body, fontWeight: '600', color: colors.text },
  meta: { fontSize: font.small, color: colors.muted },
  amount: { fontSize: font.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  qtyBtn: {
    width: 48,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: 24, color: colors.primary, fontWeight: '700' },
  qtyInput: {
    width: 64,
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    textAlign: 'center',
    fontSize: font.body + 2,
    fontWeight: '700',
    color: colors.text,
    padding: 0,
  },
  discBtn: {
    marginLeft: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.greenSoft,
    justifyContent: 'center',
  },
  discBtnOn: { backgroundColor: colors.greenSoft },
  discText: { color: colors.greenSoft, fontWeight: '600', fontSize: font.small + 1 },
  sc: { marginLeft: spacing.sm, color: colors.green, fontWeight: '700', fontSize: font.small + 1 },
  remove: { minHeight: 44, paddingHorizontal: spacing.sm, justifyContent: 'center' },
  removeText: { color: colors.danger, fontWeight: '600', fontSize: font.small + 1 },
  short: { color: colors.warning, fontSize: font.small, marginTop: spacing.xs, fontWeight: '600' },
});
