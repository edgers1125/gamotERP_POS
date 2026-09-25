// The till (landscape tablet): pricing channel + Sold By on top, the cached catalog / search / scanner on the left,
// the cart on the right with the client, Senior/PWD and sale discount, the totals (shared pricing code) and Charge.
// Selling is disabled while the sync engine reports a blockedReason (offline limits reached, device revoked, update
// required) or no cashier is signed in.
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button } from '../ui/components';
import { colors, font, radius, spacing } from '../ui/theme';
import { useCashier } from '../auth/cashierSession';
import { useSyncStatus } from '../sync/syncEngine';
import { cartProblem, cartTotals, isStatutoryLine, useCart, type CartLine } from '../sale/cart';
import { saleClientName } from '../sale/checkout';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { clientHasStatutory, draftFromClient, statutoryTypeLabel } from '../sale/statutory';
import { hasDiscount } from '../sale/totals';
import { usePosData, useStockHint } from '../sale/usePosData';
import { CartLineRow } from '../components/sale/CartLineRow';
import { ClientDialog } from '../components/sale/ClientDialog';
import { DiscountDialog } from '../components/sale/DiscountDialog';
import { ProductSearch } from '../components/sale/ProductSearch';
import { SoldByDialog } from '../components/sale/SoldByDialog';
import { StatutoryDialog } from '../components/sale/StatutoryDialog';
import { TotalsSummary } from '../components/sale/TotalsSummary';
import { Chip } from '../components/sale/ui';

export type SellScreenProps = NativeStackScreenProps<SaleStackParamList, 'Sell'>;

export function SellScreen({ navigation }: SellScreenProps) {
  const data = usePosData();
  const sync = useSyncStatus();
  const cart = useCart();
  const cashier = useCashier((s) => s.cashier);
  const [dialog, setDialog] = useState<null | 'client' | 'statutory' | 'txDiscount' | 'soldBy' | { lineSku: number }>(null);

  const blocked = sync.blockedReason ?? (cashier ? null : 'Sign in as a cashier to sell.');
  const staff = useMemo(() => data.bootstrap?.sales_staff ?? [], [data.bootstrap]);
  const channelName = data.channels.find((c) => c.id === cart.channelId)?.name ?? '—';

  // Default channel (Cash's, else the first) — and move off a channel the terminal no longer takes.
  useEffect(() => {
    if (data.loading || data.channels.length === 0) return;
    if (cart.channelId !== null && data.channels.some((c) => c.id === cart.channelId)) return;
    const next = data.defaultChannelId;
    if (next !== null) cart.setChannel(next, data.catalog, data.channels.find((c) => c.id === next)?.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loading, data.channels, data.defaultChannelId]);

  // Sold By defaults to the cashier when they're on the branch's Sales Staff (or the only person on it).
  useEffect(() => {
    if (data.loading || (cart.soldById !== null && staff.some((s) => s.id === cart.soldById))) return;
    const me = cashier ? staff.find((s) => s.id === cashier.userId) : undefined;
    const next = me?.id ?? (staff.length === 1 ? staff[0]!.id : null);
    if (next !== cart.soldById) cart.setSoldBy(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loading, staff, cashier?.userId]);

  // A newer price list re-prices what's in the cart.
  useEffect(() => {
    if (data.catalog) cart.applyCatalog(data.catalog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.catalog?.version]);

  useStockHint(cart.lines, sync.online, cart.setStock);

  const totals = useMemo(() => cartTotals(cart), [cart.lines, cart.txDiscount, cart.statutory]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = blocked ?? data.error ?? cartProblem(cart, totals);
  const eligibleCount = cart.lines.filter((l) => l.scPwdEligible).length;
  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const soldByName = staff.find((s) => s.id === cart.soldById)?.name ?? 'Choose';
  const clientLabel = cart.client.kind === 'WALK_IN' ? 'Walk-in' : (saleClientName(cart) ?? 'Client');
  const editingLine = dialog && typeof dialog === 'object' ? cart.lines.find((l) => l.skuId === dialog.lineSku) : undefined;

  function confirmClear() {
    Alert.alert('Clear the cart?', 'Every item, discount and the client are removed.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => cart.reset() },
    ]);
  }

  const renderLine = ({ item: line, index }: { item: CartLine; index: number }) => (
    <CartLineRow
      line={line}
      itemDiscountAmount={totals.itemDiscountAmounts[index] ?? 0}
      statutory={isStatutoryLine(cart, line)}
      available={cart.stock[line.skuId]}
      onQuantity={(q) => cart.setQuantity(line.skuId, q)}
      onDiscount={() => setDialog({ lineSku: line.skuId })}
      onRemove={() => cart.removeLine(line.skuId)}
      disabled={!!blocked}
    />
  );

  return (
    <View style={styles.root}>
      {blocked ? <Banner kind="danger" title="Selling is paused" message={blocked} style={styles.banner} /> : null}
      {!blocked && data.error ? <Banner kind="warning" message={data.error} style={styles.banner} /> : null}
      {!sync.online && !blocked ? (
        <Banner kind="info" message="Offline — sales are saved on this device and sent when the connection is back." style={styles.banner} />
      ) : null}

      <View style={styles.topBar}>
        <Text style={styles.topLabel}>Price at</Text>
        <View style={styles.chips}>
          {data.channels.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={c.id === cart.channelId}
              onPress={() => cart.setChannel(c.id, data.catalog, c.name)}
              disabled={!!blocked}
            />
          ))}
          {!data.loading && data.channels.length === 0 ? (
            <Text style={styles.warn}>This POS has no usable payment method, so it can’t take a sale.</Text>
          ) : null}
        </View>
        <View style={{ flex: 1 }} />
        <Text style={styles.topLabel}>Sold By</Text>
        <Chip label={soldByName} selected={cart.soldById !== null} tone="accent" onPress={() => setDialog('soldBy')} disabled={!!blocked} />
      </View>

      <View style={styles.body}>
        <View style={styles.left}>
          <ProductSearch
            catalog={data.catalog}
            channelId={cart.channelId}
            channelName={channelName}
            onAdd={(item) => cart.addItem(item, data.catalog?.version ?? null)}
            disabled={!!blocked || cart.channelId === null}
          />
        </View>

        <View style={styles.right}>
          <View style={styles.cartHeader}>
            <Text style={styles.cartTitle}>
              Cart{itemCount > 0 ? ` · ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}
            </Text>
            {cart.lines.length > 0 ? <Button title="Clear" variant="ghost" compact onPress={confirmClear} /> : null}
          </View>
          {cart.notice ? (
            <Banner kind="info" message={cart.notice} actionLabel="OK" onAction={() => cart.setNotice(null)} style={{ marginBottom: spacing.sm }} />
          ) : null}

          <FlatList
            data={cart.lines}
            keyExtractor={(l) => String(l.skuId)}
            renderItem={renderLine}
            style={styles.lines}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={styles.empty}>Tap an item or scan a barcode to add it.</Text>}
          />

          <View style={styles.actions}>
            <Chip label={`Client: ${clientLabel}`} selected={cart.client.kind !== 'WALK_IN'} onPress={() => setDialog('client')} disabled={!!blocked} />
            <Chip
              label={cart.statutory ? `${statutoryTypeLabel(cart.statutory.type)} ✓` : 'Senior / PWD'}
              selected={cart.statutory !== null}
              tone="accent"
              onPress={() => setDialog('statutory')}
              disabled={!!blocked || (eligibleCount === 0 && cart.statutory === null)}
            />
            <Chip
              label={hasDiscount(cart.txDiscount) ? `Sale discount ${formatPeso(-totals.transactionDiscountAmount)}` : 'Sale discount'}
              selected={hasDiscount(cart.txDiscount)}
              onPress={() => setDialog('txDiscount')}
              disabled={!!blocked || cart.statutory !== null || cart.lines.length === 0}
            />
          </View>

          <View style={styles.totals}>
            <TotalsSummary totals={totals} statutoryLabel={cart.statutory ? statutoryTypeLabel(cart.statutory.type) : undefined} />
          </View>
          {problem && cart.lines.length > 0 ? <Text style={styles.problem}>{problem}</Text> : null}
          <Button
            title={cart.lines.length > 0 ? `Charge ${formatPeso(totals.grandTotal)}` : 'Charge'}
            variant="accent"
            onPress={() => navigation.navigate('Payment')}
            disabled={problem !== null}
            style={styles.charge}
          />
        </View>
      </View>

      <SoldByDialog visible={dialog === 'soldBy'} staff={staff} value={cart.soldById} onPick={cart.setSoldBy} onClose={() => setDialog(null)} />
      <ClientDialog
        visible={dialog === 'client'}
        value={cart.client}
        online={sync.online}
        onClose={() => setDialog(null)}
        onSave={(client) => {
          cart.setClient(client);
          // A client on record with a Senior/PWD card switches the discount on, pre-filled (the cashier can turn it off).
          if (client.kind === 'EXISTING' && clientHasStatutory(client.client) && !cart.statutory && eligibleCount > 0) {
            cart.setStatutory(draftFromClient(client.client));
          }
        }}
      />
      <StatutoryDialog
        visible={dialog === 'statutory'}
        value={cart.statutory}
        client={cart.client}
        online={sync.online}
        eligibleCount={eligibleCount}
        onClose={() => setDialog(null)}
        onSave={(draft, client) => {
          cart.setStatutory(draft);
          cart.setClient(client);
        }}
        onRemove={() => cart.setStatutory(null)}
      />
      <DiscountDialog
        visible={dialog === 'txDiscount'}
        title="Sale discount"
        base={Math.max(totals.subtotal - totals.totalItemDiscount, 0)}
        value={cart.txDiscount}
        reason={cart.txDiscountReason}
        onSave={(d, reason) => cart.setTxDiscount(d, reason)}
        onClose={() => setDialog(null)}
      />
      <DiscountDialog
        visible={!!editingLine}
        title={editingLine ? `Discount — ${editingLine.name}` : 'Discount'}
        base={editingLine ? editingLine.quantity * editingLine.unitPrice : 0}
        value={editingLine?.discount ?? { value: '', mode: 'amount' }}
        onSave={(d) => editingLine && cart.setLineDiscount(editingLine.skuId, d)}
        onClose={() => setDialog(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  banner: { marginBottom: spacing.sm },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  topLabel: { fontSize: font.small, color: colors.muted, fontWeight: '700', textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, flexShrink: 1 },
  warn: { color: colors.warning, fontSize: font.small, fontWeight: '600' },
  body: { flex: 1, flexDirection: 'row', gap: spacing.md },
  left: { flex: 3 },
  right: {
    flex: 2,
    minWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cartHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  cartTitle: { fontSize: font.title, fontWeight: '700', color: colors.primary },
  lines: { flex: 1 },
  empty: { color: colors.muted, fontSize: font.body, textAlign: 'center', paddingVertical: spacing.xl },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  totals: { paddingVertical: spacing.xs },
  problem: { color: colors.danger, fontSize: font.small, marginBottom: spacing.xs },
  charge: { minHeight: 64, marginTop: spacing.xs },
});
