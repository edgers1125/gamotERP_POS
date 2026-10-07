// One cart line: name, price, − qty +, item discount, line total and the stock hint ("will be Oversold" when the
// online stock check says the shelf can't cover it — the sale is still recorded, stock is decided at sync).
// The controls row WRAPS: on a narrow cart the discount button drops to its own line instead of being pushed past the
// panel's edge. The discount button always shows what's applied ("Discount −₱5.00 (10%)"), and a discounted line
// shows its subtotal struck through, the discount and the amount after it.
// Store promo (src/sale/promos.ts): the regular price struck through, the promo price and a "Promo: <name>" chip. On a
// Senior/PWD sale a promo line of an eligible item asks the cashier to choose Promo or SC/PWD 20% (both amounts shown,
// the cheaper one for the customer marked; no default — Charge stays off until chosen).
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import type { CartLine } from '../../sale/cart';
import { formatPeso } from '../../sale/money';
import { PROMO_LAW_NOTE, scPwdComparison, type ChargedLine, type PromoScPwdChoice } from '../../sale/promos';
import { hasDiscount } from '../../sale/totals';
import { StatusBadge } from './ui';

export function CartLineRow({
  line,
  charged,
  itemDiscountAmount,
  statutory,
  available,
  onQuantity,
  onDiscount,
  onRemove,
  onPromoChoice,
  disabled,
}: {
  line: CartLine;
  /** What the line is charged (cart.ts chargedLineOf). */
  charged: ChargedLine;
  itemDiscountAmount: number;
  /** This line gets the Senior/PWD 20% (no item discount allowed). */
  statutory: boolean;
  /** Unexpired on-shelf units (online hint), undefined when unknown. */
  available: number | undefined;
  onQuantity: (q: number) => void;
  onDiscount: () => void;
  onRemove: () => void;
  onPromoChoice: (choice: PromoScPwdChoice) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  const [qtyText, setQtyText] = useState(String(line.quantity));
  useEffect(() => setQtyText(String(line.quantity)), [line.quantity]);
  const subtotal = line.quantity * charged.unitPrice;
  const promo = line.promo;
  // Senior/PWD sale + promo item: the cashier's choice (decision 6).
  const choosing = statutory && promo !== null;
  const comparison = choosing ? scPwdComparison(line) : null;
  const short = available !== undefined && line.quantity > available;
  const discounted = !statutory && hasDiscount(line.discount) && itemDiscountAmount > 0;
  const discountText = discounted
    ? `Discount −${formatPeso(itemDiscountAmount)}${line.discount.mode === 'percent' ? ` (${line.discount.value}%)` : ''}`
    : '+ Discount';

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <View style={styles.nameCol}>
          <Text style={styles.name} numberOfLines={2}>
            {line.name}
          </Text>
          <Text style={styles.meta}>
            {charged.promoApplied ? (
              <>
                <Text style={styles.regularStruck}>{formatPeso(line.unitPrice)}</Text> <Text style={styles.promoPrice}>{formatPeso(charged.unitPrice)}</Text>
              </>
            ) : (
              formatPeso(charged.unitPrice)
            )}{' '}
            each · {line.skuCode}
            {line.isVatable ? '' : ' · non-VAT'}
          </Text>
          {promo ? <StatusBadge label={`Promo: ${promo.name} · ${promo.terms}`} tone="success" style={styles.promoChip} /> : null}
        </View>
        <View style={styles.amountCol}>
          <Text style={discounted ? styles.amountStruck : styles.amount}>{formatPeso(subtotal)}</Text>
          {discounted ? (
            <>
              <Text style={styles.discountAmount}>−{formatPeso(itemDiscountAmount)}</Text>
              <Text style={styles.amount}>{formatPeso(Math.max(subtotal - itemDiscountAmount, 0))}</Text>
            </>
          ) : null}
        </View>
      </View>
      <View style={styles.controls}>
        <View style={styles.stepper}>
          <Pressable
            accessibilityLabel="Decrease quantity"
            style={({ pressed }) => [styles.qtyBtn, (disabled || line.quantity <= 1) && styles.qtyBtnOff, pressed && styles.pressed]}
            onPress={() => onQuantity(line.quantity - 1)}
            disabled={disabled || line.quantity <= 1}
          >
            <Text style={[styles.qtyBtnText, (disabled || line.quantity <= 1) && { color: c.disabled }]}>−</Text>
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
          <Pressable
            accessibilityLabel="Increase quantity"
            style={({ pressed }) => [styles.qtyBtn, disabled && styles.qtyBtnOff, pressed && styles.pressed]}
            onPress={() => onQuantity(line.quantity + 1)}
            disabled={disabled}
          >
            <Text style={[styles.qtyBtnText, disabled && { color: c.disabled }]}>+</Text>
          </Pressable>
        </View>

        {statutory ? (
          <StatusBadge
            label={choosing ? (line.promoChoice === 'PROMO' ? 'Promo · VAT-exempt' : line.promoChoice === 'SCPWD' ? 'SC/PWD 20%' : 'Choose below') : 'SC/PWD 20%'}
            tone={choosing && line.promoChoice === null ? 'warning' : 'primary'}
            style={styles.sc}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={discounted ? `Edit item discount, ${discountText}` : `Add a discount to ${line.name}`}
            onPress={onDiscount}
            disabled={disabled}
            style={({ pressed }) => [styles.discBtn, discounted && styles.discBtnOn, disabled && styles.discBtnOff, pressed && styles.pressed]}
          >
            <Text style={[styles.discText, disabled && { color: c.disabled }]} numberOfLines={1}>
              {discountText}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityLabel={`Remove ${line.name}`}
          onPress={onRemove}
          disabled={disabled}
          style={({ pressed }) => [styles.remove, pressed && { backgroundColor: c.dangerSoft }]}
        >
          <Text style={[styles.removeText, disabled && { color: c.disabled }]}>Remove</Text>
        </Pressable>
      </View>
      {statutory && !choosing ? <Text style={styles.scNote}>Senior/PWD 20% applies — no other discount on this item.</Text> : null}
      {choosing && comparison && promo ? (
        <View style={styles.choice}>
          <Text style={styles.choiceTitle}>Promo or Senior/PWD 20%? — choose one</Text>
          <View style={styles.choiceRow}>
            {(
              [
                { key: 'PROMO', title: `Promo “${promo.name}”`, sub: `${formatPeso(promo.price)} each · VAT-exempt`, total: comparison.promo_total },
                { key: 'SCPWD', title: 'Senior/PWD 20%', sub: `${formatPeso(line.unitPrice)} less 20% · VAT-exempt`, total: comparison.scpwd_total },
              ] as const
            ).map((o) => {
              const selected = line.promoChoice === o.key;
              const better = comparison.better === o.key;
              return (
                <Pressable
                  key={o.key}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: !!disabled }}
                  accessibilityLabel={`${o.title}, ${formatPeso(o.total)}${better ? ', better for the customer' : ''}`}
                  disabled={disabled}
                  onPress={() => onPromoChoice(o.key)}
                  style={({ pressed }) => [styles.option, better && styles.optionBetter, selected && styles.optionOn, pressed && styles.pressed]}
                >
                  <View style={styles.optionHead}>
                    <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
                    <Text style={[styles.optionTitle, selected && { color: c.primary }]} numberOfLines={2}>
                      {o.title}
                    </Text>
                  </View>
                  <Text style={styles.optionTotal}>{formatPeso(o.total)}</Text>
                  <Text style={styles.optionSub}>{o.sub}</Text>
                  {better ? <StatusBadge label="Better for the customer" tone="success" /> : null}
                </Pressable>
              );
            })}
          </View>
          {comparison.better === 'EQUAL' ? <Text style={styles.choiceNote}>Both come to the same amount.</Text> : null}
          <Text style={styles.choiceNote}>{PROMO_LAW_NOTE}</Text>
        </View>
      ) : null}
      {short ? (
        <Text style={styles.short}>
          {available! <= 0 ? 'Out of stock' : `Only ${available} on the shelf`} — this sale will be recorded as Oversold.
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  top: { flexDirection: 'row', gap: spacing.sm },
  nameCol: { flex: 1, minWidth: 0 },
  name: { ...t.bodyStrong },
  meta: { ...t.caption },
  amountCol: { alignItems: 'flex-end' },
  amount: { ...t.money },
  amountStruck: { ...t.caption, textDecorationLine: 'line-through', fontVariant: ['tabular-nums'] },
  discountAmount: { ...t.caption, fontFamily: t.bodyStrong.fontFamily, color: c.success, fontVariant: ['tabular-nums'] },
  // Wraps: stepper + discount + Remove on one line when they fit; discount/Remove move to the next line when not.
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  pressed: { backgroundColor: c.primarySoft },
  qtyBtn: {
    width: 48,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  qtyBtnOff: { borderColor: c.border },
  qtyBtnText: { ...t.heading, fontSize: 22, lineHeight: 26, color: c.primary },
  qtyInput: {
    ...t.money,
    fontSize: 17,
    width: 64,
    height: 44,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.md,
    textAlign: 'center',
    padding: 0,
    backgroundColor: c.surface,
  },
  discBtn: {
    flexShrink: 1,
    maxWidth: '100%',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primary,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  discBtnOn: { backgroundColor: c.primarySoftStrong },
  discBtnOff: { borderColor: c.border },
  discText: { ...t.button, fontSize: 14, color: c.primary },
  sc: { alignSelf: 'center' },
  scNote: { ...t.caption, fontSize: 12, marginTop: spacing.xs },
  // marginLeft 'auto' keeps Remove at the right end of whichever line it lands on.
  remove: { marginLeft: 'auto', minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, justifyContent: 'center' },
  removeText: { ...t.button, fontSize: 14, color: c.danger },
  regularStruck: { textDecorationLine: 'line-through', color: c.muted },
  promoPrice: { fontFamily: t.bodyStrong.fontFamily, color: c.success },
  promoChip: { marginTop: spacing.xs },
  choice: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.warning,
    backgroundColor: c.warningSoft,
    gap: spacing.xs,
  },
  choiceTitle: { ...t.bodyStrong, fontSize: 14 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    flexGrow: 1,
    flexBasis: 150,
    minHeight: 44,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    gap: 2,
  },
  optionBetter: { borderColor: c.success, borderWidth: 2 },
  optionOn: { backgroundColor: c.primarySoft, borderColor: c.primary },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionTitle: { ...t.subtitle, fontSize: 14, flex: 1 },
  optionTotal: { ...t.money },
  optionSub: { ...t.caption, fontSize: 12 },
  choiceNote: { ...t.caption, fontSize: 12 },
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
  short: { ...t.caption, fontFamily: t.bodyStrong.fontFamily, color: c.warning, marginTop: spacing.xs },
}));
