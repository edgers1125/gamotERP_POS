// The sale's figures, straight from the shared pricing code's result (src/sale/totals.ts). Prices are before VAT, so
// VAT is added on top; Senior/PWD lines are VAT-exempt.
// With `saleDiscount` (the till), the sale-discount row is also where it's added/edited: an "+ Add sale discount" row
// in its place in the totals when there's none, the applied row with "Edit" when there is one — so the entry point
// sits exactly where the discount shows, never on a separate chip that can scroll or squeeze out of view.
import { Pressable, Text, View } from 'react-native';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { hasDiscount, type DiscountDraft, type SaleTotals } from '../../sale/totals';
import { formatPeso } from '../../sale/money';
import { SummaryRow } from './ui';

export interface SaleDiscountControl {
  value: DiscountDraft;
  reason: string;
  onEdit: () => void;
  /** Why a sale discount can't be added right now (Senior/PWD sale, empty cart, selling paused) — null = it can. */
  blockedReason: string | null;
}

export function TotalsSummary({
  totals,
  statutoryLabel,
  saleDiscount,
  saleDiscountValue,
  saleDiscountReason,
}: {
  totals: SaleTotals;
  statutoryLabel?: string;
  /** Makes the sale-discount row editable (Sell screen). */
  saleDiscount?: SaleDiscountControl;
  /** Read-only display of the typed discount (Payment screen) — shows "(10%)" and the reason. */
  saleDiscountValue?: DiscountDraft;
  saleDiscountReason?: string;
}) {
  const styles = useStyles();
  const theme = useThemeColors();
  const draft = saleDiscount?.value ?? saleDiscountValue;
  const reason = (saleDiscount?.reason ?? saleDiscountReason ?? '').trim();
  const applied = totals.transactionDiscountAmount > 0;
  const pct = draft && draft.mode === 'percent' && hasDiscount(draft) ? ` (${draft.value}%)` : '';

  return (
    <View>
      <SummaryRow label="Subtotal" value={formatPeso(totals.subtotal)} />
      {totals.totalItemDiscount > 0 ? <SummaryRow label="Item discounts" value={formatPeso(-totals.totalItemDiscount)} tone="success" /> : null}

      {saleDiscount ? (
        applied ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Edit the sale discount, ${formatPeso(totals.transactionDiscountAmount)}`}
            onPress={saleDiscount.onEdit}
            disabled={saleDiscount.blockedReason !== null}
            style={({ pressed }) => [styles.editRow, pressed && styles.pressed]}
          >
            <View style={styles.editLabelCol}>
              <Text style={styles.discountLabel}>
                Sale discount{pct} <Text style={styles.editLink}>{saleDiscount.blockedReason === null ? '· Edit' : ''}</Text>
              </Text>
              {reason ? (
                <Text style={styles.reason} numberOfLines={2}>
                  Reason: {reason}
                </Text>
              ) : null}
            </View>
            <Text style={styles.discountValue}>{formatPeso(-totals.transactionDiscountAmount)}</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a discount to the whole sale"
              accessibilityState={{ disabled: saleDiscount.blockedReason !== null }}
              onPress={saleDiscount.onEdit}
              disabled={saleDiscount.blockedReason !== null}
              style={({ pressed }) => [
                styles.addRow,
                saleDiscount.blockedReason !== null && styles.addRowOff,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.addText, saleDiscount.blockedReason !== null && { color: theme.disabled }]}>+ Add sale discount</Text>
            </Pressable>
            {saleDiscount.blockedReason ? <Text style={styles.blocked}>{saleDiscount.blockedReason}</Text> : null}
          </>
        )
      ) : applied ? (
        <>
          <SummaryRow label={`Sale discount${pct}`} value={formatPeso(-totals.transactionDiscountAmount)} tone="success" />
          {reason ? (
            <Text style={styles.reason} numberOfLines={2}>
              Reason: {reason}
            </Text>
          ) : null}
        </>
      ) : null}

      {totals.totalStatutoryDiscount > 0 ? (
        <SummaryRow label={`${statutoryLabel ?? 'Senior/PWD'} 20%`} value={formatPeso(-totals.totalStatutoryDiscount)} tone="success" />
      ) : null}
      {totals.vatExemptSales > 0 ? <SummaryRow label="VAT-exempt sales" value={formatPeso(totals.vatExemptSales)} tone="muted" /> : null}
      <SummaryRow label="VAT (12%)" value={formatPeso(totals.totalVat)} tone="muted" />
      <SummaryRow label="Total" value={formatPeso(totals.grandTotal)} strong />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  pressed: { backgroundColor: c.primarySoft },
  // The applied sale discount — same line as a SummaryRow, tappable to edit.
  editRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: 3,
    marginHorizontal: -spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
  },
  editLabelCol: { flex: 1, minWidth: 0 },
  discountLabel: { ...t.body, color: c.success },
  editLink: { ...t.button, fontSize: 14, color: c.primary },
  discountValue: { ...t.money, fontFamily: t.body.fontFamily, color: c.success },
  reason: { ...t.caption, fontSize: 12 },
  // No sale discount yet: an outlined, full-width "+ Add sale discount" row in its place among the totals.
  addRow: {
    minHeight: 44,
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addRowOff: { borderColor: c.border, backgroundColor: c.surfaceMuted },
  addText: { ...t.button, fontSize: 14, color: c.primary },
  blocked: { ...t.caption, fontSize: 12, marginBottom: spacing.xs },
}));
