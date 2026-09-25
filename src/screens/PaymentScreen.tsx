// Tender for the cart in `useCart`: payments of the sale's pricing channel only (split tender within that channel),
// reference numbers where the method requires one, cash received ≥ the cash amount gives change. Complete Sale asks
// for the co-signer when any item/sale discount is non-zero (code typed by the approver here), then records the sale
// locally (device-assigned invoice number, signed op in the outbox — works offline) and shows the receipt.
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button } from '../ui/components';
import { colors, font, radius, spacing } from '../ui/theme';
import { useCashier } from '../auth/cashierSession';
import { useSyncStatus } from '../sync/syncEngine';
import { cartProblem, cartTotals, discountNeedsApproval, useCart } from '../sale/cart';
import { completeSale, saleClientName, type Approval } from '../sale/checkout';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { newPaymentLine, paymentsState, syncAutoLine, type PaymentDraft } from '../sale/payments';
import { statutoryTypeLabel } from '../sale/statutory';
import { usePosData } from '../sale/usePosData';
import { ApproverDialog } from '../components/sale/ApproverDialog';
import { PaymentLineCard } from '../components/sale/PaymentLineCard';
import { TotalsSummary } from '../components/sale/TotalsSummary';
import { HintText, SectionTitle } from '../components/sale/ui';

export type PaymentScreenProps = NativeStackScreenProps<SaleStackParamList, 'Payment'>;

export function PaymentScreen({ navigation }: PaymentScreenProps) {
  const data = usePosData();
  const sync = useSyncStatus();
  const cart = useCart();
  const cashier = useCashier((s) => s.cashier);
  const [lines, setLines] = useState<PaymentDraft[]>([]);
  const [approving, setApproving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => cartTotals(cart), [cart.lines, cart.txDiscount, cart.statutory]); // eslint-disable-line react-hooks/exhaustive-deps
  const grandTotal = totals.grandTotal;
  const methods = useMemo(() => data.methods.filter((m) => m.pricing_channel_id === cart.channelId), [data.methods, cart.channelId]);
  const channelName = data.channels.find((c) => c.id === cart.channelId)?.name ?? '—';
  const pay = paymentsState(lines, methods, grandTotal);
  const needsApproval = discountNeedsApproval(totals);
  const blocked = sync.blockedReason ?? (cashier ? null : 'Sign in as a cashier to sell.');
  const problem = blocked ?? cartProblem(cart, totals) ?? pay.problem;

  // The auto line follows the total.
  useEffect(() => {
    setLines((prev) => syncAutoLine(prev, grandTotal));
  }, [grandTotal]);

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
      const sale = await completeSale({ state: useCart.getState(), payments: lines, methods, approval, online: sync.online });
      setApproving(false);
      navigation.replace('Receipt', { clientUuid: sale.client_uuid });
      useCart.getState().reset();
    } catch (e) {
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
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={styles.emptyText}>The cart is empty.</Text>
        <Button title="Back to the till" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {blocked ? <Banner kind="danger" title="Selling is paused" message={blocked} style={{ marginBottom: spacing.sm }} /> : null}
      {error ? <Banner kind="danger" message={error} style={{ marginBottom: spacing.sm }} /> : null}
      <View style={styles.body}>
        <View style={styles.left}>
          <View style={styles.headerRow}>
            <Button title="‹ Back to cart" variant="ghost" compact onPress={() => navigation.goBack()} disabled={busy} />
            <Text style={styles.channel}>Priced at {channelName}</Text>
          </View>
          <ScrollView style={{ flex: 1 }}>
            {cart.lines.map((l, idx) => (
              <View key={l.skuId} style={styles.orderLine}>
                <Text style={styles.orderName} numberOfLines={2}>
                  {l.quantity} × {l.name}
                </Text>
                <Text style={styles.orderAmount}>{formatPeso(totals.lines[idx]?.lineSubtotal ?? 0)}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.meta}>
            <Text style={styles.metaText}>Client: {saleClientName(cart) ?? 'Walk-in'}</Text>
            {cart.statutory ? (
              <Text style={styles.metaText}>
                {statutoryTypeLabel(cart.statutory.type)} ID {cart.statutory.idNumber}
              </Text>
            ) : null}
            <Text style={styles.metaText}>Sold by: {data.bootstrap?.sales_staff.find((s) => s.id === cart.soldById)?.name ?? '—'}</Text>
          </View>
          <TotalsSummary totals={totals} statutoryLabel={cart.statutory ? statutoryTypeLabel(cart.statutory.type) : undefined} />
        </View>

        <View style={styles.right}>
          <View style={styles.due}>
            <Text style={styles.dueLabel}>Amount due</Text>
            <Text style={styles.dueValue}>{formatPeso(grandTotal)}</Text>
          </View>
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
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

          <View style={styles.footer}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.remaining, { color: pay.remaining === 0 ? colors.success : colors.danger }]}>
                {pay.remaining === 0 ? 'Paid in full' : pay.remaining > 0 ? `Remaining ${formatPeso(pay.remaining)}` : `Over by ${formatPeso(-pay.remaining)}`}
              </Text>
              {problem ? <Text style={styles.problem}>{problem}</Text> : null}
              {needsApproval && !problem ? <Text style={styles.hint}>A discount is applied — an approver’s code is asked next.</Text> : null}
            </View>
            <Button title="Complete sale" variant="accent" onPress={onComplete} disabled={problem !== null} loading={busy && !approving} style={styles.complete} />
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  emptyText: { fontSize: font.title, color: colors.muted, marginBottom: spacing.lg },
  body: { flex: 1, flexDirection: 'row', gap: spacing.md },
  left: {
    flex: 2,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  channel: { fontSize: font.small, color: colors.muted, fontWeight: '700' },
  orderLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: spacing.xs },
  orderName: { flex: 1, fontSize: font.body, color: colors.text },
  orderAmount: { fontSize: font.body, color: colors.text, fontVariant: ['tabular-nums'] },
  meta: { borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.sm, marginTop: spacing.sm },
  metaText: { fontSize: font.small, color: colors.muted },
  right: { flex: 3 },
  due: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  dueLabel: { color: '#fff', fontSize: font.title, fontWeight: '600' },
  dueValue: { color: '#fff', fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'] },
  warn: { color: colors.warning, fontSize: font.body, marginBottom: spacing.md },
  methodButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  methodButton: { minWidth: 160, minHeight: 64 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  remaining: { fontSize: font.title, fontWeight: '700' },
  problem: { color: colors.danger, fontSize: font.small },
  hint: { color: colors.muted, fontSize: font.small },
  complete: { minHeight: 64, minWidth: 260 },
});
