// Tender for the cart in `useCart`: payments of the sale's pricing channel only (split tender within that channel),
// reference numbers where the method requires one, cash received ≥ the cash amount gives change. Complete Sale asks
// for the co-signer when any item/sale discount is non-zero (code typed by the approver here), then records the sale
// locally (device-assigned invoice number, signed op in the outbox — works offline) and shows the receipt.
// Layout: order summary | tender side by side from 720dp wide; stacked below that (portrait / phone), where the order
// summary — lines with their item discounts, the sale discount and the totals — scrolls as one so none of it is
// squeezed out.
// Store promos: Complete sale re-checks every line's promo at that instant (a promo may have started / ended while the
// cart was open, offline too). A change updates the cart and stops here with a message — the amount due changed, so the
// cashier checks it and completes again; the sale's sold_at is exactly the instant the promos were checked at.
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button } from '../ui/components';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';
import { useCashier } from '../auth/cashierSession';
import { customerDisplay } from '../display/customerDisplay';
import { useSyncStatus } from '../sync/syncEngine';
import { cartProblem, cartTotals, chargedLineOf, discountNeedsApproval, isStatutoryLine, useCart } from '../sale/cart';
import { completeSale, PromoChangedError, saleClientName, type Approval } from '../sale/checkout';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { newPaymentLine, paymentsState, syncAutoLine, type PaymentDraft } from '../sale/payments';
import { statutoryTypeLabel } from '../sale/statutory';
import { usePosData } from '../sale/usePosData';
import { ApproverDialog } from '../components/sale/ApproverDialog';
import { PaymentLineCard } from '../components/sale/PaymentLineCard';
import { TotalsSummary } from '../components/sale/TotalsSummary';
import { HintText, SectionTitle } from '../components/sale/ui';
import { DrawerGateBanner } from '../components/drawer/DrawerGateBanner';
import { useDrawerGate } from '../drawer/useCashDrawer';

export type PaymentScreenProps = NativeStackScreenProps<SaleStackParamList, 'Payment'>;

export function PaymentScreen({ navigation }: PaymentScreenProps) {
  const styles = useStyles();
  const c = useThemeColors();
  const data = usePosData();
  const sync = useSyncStatus();
  const cart = useCart();
  const cashier = useCashier((s) => s.cashier);
  const [lines, setLines] = useState<PaymentDraft[]>([]);
  const [approving, setApproving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wide = useWindowDimensions().width >= 720;

  const totals = useMemo(() => cartTotals(cart), [cart.lines, cart.txDiscount, cart.statutory]); // eslint-disable-line react-hooks/exhaustive-deps
  const grandTotal = totals.grandTotal;
  const methods = useMemo(() => data.methods.filter((m) => m.pricing_channel_id === cart.channelId), [data.methods, cart.channelId]);
  const channelName = data.channels.find((ch) => ch.id === cart.channelId)?.name ?? '—';
  const pay = paymentsState(lines, methods, grandTotal);
  const needsApproval = discountNeedsApproval(totals);
  const blocked = sync.blockedReason ?? (cashier ? null : 'Sign in as a cashier to sell.');
  const drawer = useDrawerGate();
  const problem = blocked ?? drawer.problem ?? cartProblem(cart, totals) ?? pay.problem;

  // The auto line follows the total.
  useEffect(() => {
    setLines((prev) => syncAutoLine(prev, grandTotal));
  }, [grandTotal]);

  // Customer display: cash received + change, once the (single) cash line is valid — pay.change is null otherwise.
  const cashTendered = lines.find((l) => methods.find((m) => m.id === l.methodId)?.kind === 'CASH')?.tendered ?? null;
  useEffect(() => {
    customerDisplay.setPayment(pay.change !== null && cashTendered !== null ? { tendered: Number(cashTendered), change: pay.change } : null);
  }, [pay.change, cashTendered]);
  useEffect(() => () => customerDisplay.setPayment(null), []);

  function update(key: number, patch: Partial<PaymentDraft>) {
    setLines((prev) => syncAutoLine(prev.map((l) => (l.key === key ? { ...l, ...patch } : l)), grandTotal));
  }

  function payRemainingWith(methodId: number) {
    setLines((prev) => syncAutoLine([...prev.map((l) => ({ ...l, auto: false })), newPaymentLine(methodId, Math.max(pay.remaining, 0), true)], grandTotal));
  }

  async function record(approval: Approval | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Re-check the promos NOW (the device clock — the same instant goes out as sold_at).
      const soldAt = new Date();
      const promoChange = useCart.getState().refreshPromos(soldAt);
      if (promoChange) {
        setError(`${promoChange} Check the amount due and complete the sale again.`);
        setApproving(false);
        return;
      }
      const sale = await completeSale({ state: useCart.getState(), payments: lines, methods, approval, online: sync.online, soldAt });
      setApproving(false);
      navigation.replace('Receipt', { clientUuid: sale.client_uuid });
      useCart.getState().reset();
    } catch (e) {
      if (e instanceof PromoChangedError) useCart.getState().refreshPromos();
      setError(e instanceof Error ? e.message : 'The sale couldn’t be saved.');
      setApproving(false);
    } finally {
      setBusy(false);
    }
  }

  function onComplete() {
    if (problem !== null || busy) return;
    if (needsApproval) setApproving(true);
    else void record(null);
  }

  if (cart.lines.length === 0) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.emptyText}>The cart is empty.</Text>
        <Button title="Back to the till" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  // Client / Sold by and the totals (item + sale discounts shown as their own rows).
  const orderFooter = (
    <>
      <View style={styles.meta}>
        <Text style={styles.metaText}>Client: {saleClientName(cart) ?? 'Walk-in'}</Text>
        {cart.statutory ? (
          <Text style={styles.metaText}>
            {statutoryTypeLabel(cart.statutory.type)} ID {cart.statutory.idNumber}
          </Text>
        ) : null}
        <Text style={styles.metaText}>Cashier: {cashier?.name ?? '—'}</Text>
        <Text style={styles.metaText}>Sold by: {data.bootstrap?.sales_staff.find((s) => s.id === cart.soldById)?.name ?? '—'}</Text>
      </View>
      <TotalsSummary
        totals={totals}
        statutoryLabel={cart.statutory ? statutoryTypeLabel(cart.statutory.type) : undefined}
        saleDiscountValue={cart.txDiscount}
        saleDiscountReason={cart.txDiscountReason}
      />
    </>
  );

  return (
    <View style={styles.root}>
      {blocked ? <Banner kind="danger" title={sync.subscriptionLocked ? 'Subscription locked — selling stopped' : 'Selling is paused'} message={blocked} style={styles.banner} /> : null}
      {!blocked ? <DrawerGateBanner gate={drawer} style={styles.banner} /> : null}
      {error ? <Banner kind="danger" message={error} style={styles.banner} /> : null}
      {!error && cart.notice ? (
        <Banner kind="info" message={cart.notice} actionLabel="OK" onAction={() => cart.setNotice(null)} style={styles.banner} />
      ) : null}
      <View style={[styles.body, !wide && styles.bodyStacked]}>
        <View style={[styles.left, !wide && styles.leftStacked]}>
          <View style={styles.headerRow}>
            <Button title="‹ Back to cart" variant="ghost" compact onPress={() => navigation.goBack()} disabled={busy} />
            <Text style={styles.channel}>Priced at {channelName}</Text>
          </View>
          <ScrollView style={styles.flex}>
            {cart.lines.map((l, idx) => {
              const charged = chargedLineOf(cart, l);
              const choice = isStatutoryLine(cart, l) && l.promo ? l.promoChoice : null;
              return (
              <View key={l.skuId} style={styles.orderLine}>
                <View style={styles.flex}>
                  <Text style={styles.orderName} numberOfLines={2}>
                    {l.quantity} × {l.name}
                  </Text>
                  {charged.promoApplied && l.promo ? (
                    <Text style={styles.orderPromo}>
                      Promo: {l.promo.name} · <Text style={styles.struck}>{formatPeso(l.unitPrice)}</Text> {formatPeso(charged.unitPrice)} each
                      {choice === 'PROMO' ? ' · chosen over SC/PWD 20%' : ''}
                    </Text>
                  ) : null}
                  {choice === 'SCPWD' && l.promo ? <Text style={styles.orderPromo}>SC/PWD 20% chosen over the promo “{l.promo.name}”</Text> : null}
                </View>
                <View style={styles.orderAmounts}>
                  <Text style={styles.orderAmount}>{formatPeso(totals.lines[idx]?.lineSubtotal ?? 0)}</Text>
                  {(totals.itemDiscountAmounts[idx] ?? 0) > 0 ? (
                    <Text style={styles.orderDiscount}>
                      Discount {formatPeso(-(totals.itemDiscountAmounts[idx] ?? 0))}
                      {l.discount.mode === 'percent' ? ` (${l.discount.value}%)` : ''}
                    </Text>
                  ) : null}
                </View>
              </View>
              );
            })}
            {wide ? null : orderFooter}
          </ScrollView>
          {wide ? orderFooter : null}
        </View>

        <View style={[styles.right, !wide && styles.rightStacked]}>
          <View style={styles.due}>
            <Text style={styles.dueLabel}>Amount due</Text>
            <Text style={styles.dueValue}>{formatPeso(grandTotal)}</Text>
          </View>
          <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
            {grandTotal <= 0 && lines.length === 0 ? <HintText>Nothing to pay — a zero-total sale takes no payment.</HintText> : null}
            {methods.length === 0 ? (
              <Text style={styles.warn}>This POS has no payment method for the {channelName} channel — go back and choose another pricing channel.</Text>
            ) : null}
            {lines.map((line, idx) => (
              <PaymentLineCard
                key={line.key}
                line={line}
                methods={methods}
                error={pay.errors[idx] ?? null}
                cashTaken={lines.some((l) => l.key !== line.key && methods.find((m) => m.id === l.methodId)?.kind === 'CASH')}
                onChange={(patch) => update(line.key, patch)}
                onRemove={() => setLines((prev) => syncAutoLine(prev.filter((l) => l.key !== line.key), grandTotal))}
                disabled={busy}
              />
            ))}
            {pay.remaining > 0 ? (
              <>
                <SectionTitle>{lines.length === 0 ? 'Pay with' : `Pay the remaining ${formatPeso(pay.remaining)} with`}</SectionTitle>
                <View style={styles.methodButtons}>
                  {methods.map((m) => (
                    <Button
                      key={m.id}
                      title={m.name}
                      variant="secondary"
                      onPress={() => payRemainingWith(m.id)}
                      disabled={busy || (m.kind === 'CASH' && pay.cashLines > 0)}
                      style={styles.methodButton}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, !wide && styles.footerStacked]}>
            <View style={wide ? styles.flex : null}>
              <Text style={[styles.remaining, { color: pay.remaining === 0 ? c.success : c.danger }]}>
                {pay.remaining === 0 ? 'Paid in full' : pay.remaining > 0 ? `Remaining ${formatPeso(pay.remaining)}` : `Over by ${formatPeso(-pay.remaining)}`}
              </Text>
              {problem ? <Text style={styles.problem}>{problem}</Text> : null}
              {needsApproval && !problem ? <Text style={styles.hint}>A discount is applied — an approver’s code is asked next.</Text> : null}
            </View>
            <Button title="Complete sale" variant="primary" onPress={onComplete} disabled={problem !== null} loading={busy && !approving} style={styles.complete} />
          </View>
        </View>
      </View>

      <ApproverDialog
        visible={approving}
        kind="DISCOUNT"
        online={sync.online}
        busy={busy}
        explanation={`Discounts of ${formatPeso(totals.totalItemDiscount + totals.transactionDiscountAmount)} on this sale need an approver.`}
        onApprove={(a) => void record(a)}
        onClose={() => !busy && setApproving(false)}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  emptyText: { ...t.heading, color: c.muted },
  banner: { marginBottom: spacing.md },
  body: { flex: 1, flexDirection: 'row', gap: spacing.lg },
  bodyStacked: { flexDirection: 'column', gap: spacing.md },
  left: {
    flex: 2,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  leftStacked: { flex: 1, padding: spacing.md },
  rightStacked: { flex: 1.2 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  channel: { ...t.label, color: c.muted },
  flex: { flex: 1 },
  orderLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  orderName: { ...t.body },
  orderPromo: { ...t.caption, fontSize: 12, color: c.success },
  struck: { textDecorationLine: 'line-through', color: c.muted },
  orderAmounts: { alignItems: 'flex-end' },
  orderAmount: { ...t.money },
  orderDiscount: { ...t.caption, fontSize: 12, color: c.success, fontVariant: ['tabular-nums'] },
  meta: { borderTopWidth: 1, borderTopColor: c.border, paddingVertical: spacing.sm, marginTop: spacing.sm, gap: 2 },
  metaText: { ...t.caption },
  right: { flex: 3 },
  due: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
    ...shadow.card,
  },
  dueLabel: { ...t.heading, color: c.textSecondary },
  dueValue: { ...t.display, fontSize: 40, color: c.primary, fontVariant: ['tabular-nums'] },
  warn: {
    ...t.body,
    color: c.warning,
    backgroundColor: c.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  methodButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  methodButton: { minWidth: 160, minHeight: 56 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  remaining: { ...t.title, fontVariant: ['tabular-nums'] },
  problem: { ...t.caption, color: c.danger },
  hint: { ...t.caption },
  // Same height as the checkout actions on Sell and Receipt.
  complete: { minHeight: 56, minWidth: 260 },
  // Narrow: the remaining/approval text above a full-width Complete button, instead of squeezed beside it.
  footerStacked: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.sm },
}));
