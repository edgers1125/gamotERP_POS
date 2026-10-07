// The till (landscape tablet): pricing channel + Sold By (picked by the cashier every time, then sticky) on top, the cached catalog / search / scanner on the left,
// the cart on the right with the client, Senior/PWD and sale discount, the totals (shared pricing code) and Charge.
// Selling is disabled while the sync engine reports a blockedReason (offline limits reached, device revoked, update
// required) or no cashier is signed in.
// Layout: side by side when the window is ≥ 720dp wide (landscape tablet), stacked (search above cart) when narrower
// (portrait / phone). In the cart, Charge is pinned at the bottom; the client, totals and the sale-discount row sit
// under the lines as a fixed block only while the panel is tall enough to leave the lines real room — otherwise
// everything above Charge scrolls as one, so no line's discount button or the totals ever get squeezed to nothing
// (e.g. a short landscape screen, or the on-screen keyboard open).
import { useEffect, useMemo, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button } from '../ui/components';
import { makeStyles } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';
import { useCashier } from '../auth/cashierSession';
import { useSyncStatus } from '../sync/syncEngine';
import { cartProblem, cartTotals, chargedLineOf, displayPhone, isStatutoryLine, newClientUuid, useCart } from '../sale/cart';
import { promosOf } from '../sale/promos';
import { saleClientName } from '../sale/checkout';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { clientHasStatutory, clientStatutoryBlock, draftFromClient, statutoryTypeLabel } from '../sale/statutory';
import { usePosData, useStockHint } from '../sale/usePosData';
import { CartLineRow } from '../components/sale/CartLineRow';
import { ClientDialog } from '../components/sale/ClientDialog';
import { DiscountDialog } from '../components/sale/DiscountDialog';
import { ProductSearch } from '../components/sale/ProductSearch';
import { SoldByDialog } from '../components/sale/SoldByDialog';
import { TotalsSummary } from '../components/sale/TotalsSummary';
import { Chip } from '../components/sale/ui';
import { DrawerGateBanner } from '../components/drawer/DrawerGateBanner';
import { useDrawerGate } from '../drawer/useCashDrawer';

/** Window width from which the search and the cart sit side by side. */
const WIDE_MIN_WIDTH = 720;
/** Height the cart panel needs beyond the client/totals block to keep that block fixed (header, Charge, ~2 lines). */
const LINES_MIN_ROOM = 380;
/** How often an open cart re-checks its store promos (a promo starting / ending while the cart is open). */
const PROMO_TICK_MS = 15_000;

export type SellScreenProps = NativeStackScreenProps<SaleStackParamList, 'Sell'>;

export function SellScreen({ navigation }: SellScreenProps) {
  const styles = useStyles();
  const data = usePosData();
  const sync = useSyncStatus();
  const cart = useCart();
  const cashier = useCashier((s) => s.cashier);
  const [dialog, setDialog] = useState<null | 'client' | 'txDiscount' | 'soldBy' | { lineSku: number }>(null);
  // The existing client whose card the cashier switched off (buying for someone else) — not re-applied for them.
  const [statutoryOffFor, setStatutoryOffFor] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN_WIDTH;
  // Cart panel height vs. the client/totals block: decides whether that block is pinned or scrolls with the lines.
  const [panelH, setPanelH] = useState(0);
  const [summaryH, setSummaryH] = useState(0);
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const roomy = panelH > 0 && summaryH > 0 && panelH - summaryH >= LINES_MIN_ROOM;
  // Frozen while the keyboard is up, so a resize from the keyboard doesn't reshuffle the cart under the cashier's finger.
  const [pinSummary, setPinSummary] = useState(false);
  useEffect(() => {
    if (!keyboardUp) setPinSummary(roomy);
  }, [roomy, keyboardUp]);

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

  // Sold By is never filled in by the app (user decision 2026-10-07 — not the cashier, not the only person on the list):
  // the cashier picks it ("Me" when they sold it). It stays for the next sale (sticky) until changed, the till locks
  // or another cashier signs in (src/auth/tillLock.ts). Someone taken off the branch's Sales Staff is un-picked.
  useEffect(() => {
    if (data.loading || cart.soldById === null || staff.some((s) => s.id === cart.soldById)) return;
    cart.setSoldBy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loading, staff, cart.soldById]);

  // A newer price list re-prices what's in the cart.
  useEffect(() => {
    if (data.catalog) cart.applyCatalog(data.catalog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.catalog?.version]);

  // Store promos from the cached bootstrap (absent from an older server → none): a new bootstrap (publish / cancel / end
  // early arrive as a real-time 'terminal' notice → bootstrap re-read) re-checks the cart at once; while the cart is
  // open a promo starting or ending on time is picked up within PROMO_TICK_MS (offline too — device clock).
  const promos = useMemo(() => promosOf(data.bootstrap), [data.bootstrap]);
  useEffect(() => {
    // Not before the cached bootstrap is read (null while loading) — that would drop every line's promo (and choice).
    if (data.bootstrap) useCart.getState().setPromos(promos);
  }, [data.bootstrap, promos]);
  const hasLines = cart.lines.length > 0;
  useEffect(() => {
    if (!hasLines || promos.length === 0) return;
    const t = setInterval(() => useCart.getState().refreshPromos(), PROMO_TICK_MS);
    return () => clearInterval(t);
  }, [hasLines, promos]);

  useStockHint(cart.lines, sync.online, cart.setStock);

  const totals = useMemo(() => cartTotals(cart), [cart.lines, cart.txDiscount, cart.statutory]); // eslint-disable-line react-hooks/exhaustive-deps
  // No open cash drawer on this terminal → Charge stays off (localStore.recordSale refuses too).
  const drawer = useDrawerGate();
  const problem = blocked ?? drawer.problem ?? data.error ?? cartProblem(cart, totals);
  const eligibleCount = cart.lines.filter((l) => l.scPwdEligible).length;
  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const soldByName = staff.find((s) => s.id === cart.soldById)?.name ?? 'Choose who sold it';
  const clientName = saleClientName(cart);
  const clientLabel =
    cart.client.kind === 'UNSET'
      ? null
      : cart.client.kind === 'WALK_IN'
        ? `${clientName ?? 'Walk-in'} · no client details`
        : cart.client.kind === 'EXISTING'
          ? `${clientName ?? 'Client'} · returning`
          : `${clientName ?? 'New client'} · new${cart.client.phone ? ` · ${displayPhone(cart.client.phone)}` : ''}`;
  // Senior/PWD is chosen inside the client form (first section) — shown with the client, not as its own button.
  const statutoryLabel = cart.statutory ? `${statutoryTypeLabel(cart.statutory.type)} ✓ 20% off eligible items` : null;
  const existingClient = cart.client.kind === 'EXISTING' ? cart.client.client : null;
  // A card on record that can't be applied as-is (expired or undated PWD ID) — said once, next to the client.
  const cardBlock = existingClient && !cart.statutory ? clientStatutoryBlock(existingClient) : null;

  // Picking an existing client with a valid Senior/PWD card on record switches the discount on, pre-filled — also when
  // the eligible items are added after the client. A Senior ID never expires; an expired PWD ID is never applied.
  useEffect(() => {
    if (!existingClient || cart.statutory || eligibleCount === 0 || statutoryOffFor === existingClient.id) return;
    if (!clientHasStatutory(existingClient) || clientStatutoryBlock(existingClient) !== null) return;
    cart.setStatutory(draftFromClient(existingClient));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingClient, cart.statutory, eligibleCount, statutoryOffFor]);
  const editingLine = dialog && typeof dialog === 'object' ? cart.lines.find((l) => l.skuId === dialog.lineSku) : undefined;
  // The existing rules, said where the sale discount is entered (cart.ts enforces them; this only shows them).
  const saleDiscountBlocked = blocked
    ? 'Selling is paused.'
    : cart.statutory !== null
      ? 'A transaction discount can’t be combined with the Senior/PWD discount.'
      : cart.lines.length === 0
        ? 'Add an item first.'
        : null;

  function confirmClear() {
    Alert.alert('Clear the cart?', 'Every item, discount and the client are removed.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          cart.reset();
          setStatutoryOffFor(null);
        },
      },
    ]);
  }

  const lineRows = cart.lines.map((line, index) => (
    <CartLineRow
      key={line.skuId}
      line={line}
      charged={chargedLineOf(cart, line)}
      onPromoChoice={(choice) => cart.setPromoChoice(line.skuId, choice)}
      itemDiscountAmount={totals.itemDiscountAmounts[index] ?? 0}
      statutory={isStatutoryLine(cart, line)}
      available={cart.stock[line.skuId]}
      onQuantity={(q) => cart.setQuantity(line.skuId, q)}
      onDiscount={() => setDialog({ lineSku: line.skuId })}
      onRemove={() => cart.removeLine(line.skuId)}
      disabled={!!blocked}
    />
  ));

  // The client, the totals (with the sale-discount row, where it's added/edited) and what's still missing.
  const summary = (
    <View onLayout={(e) => setSummaryH(e.nativeEvent.layout.height)}>
      {/* The sale's client — after the items, before Senior/PWD and discounts. Required, like the web: the Charge
          button stays off until a client is chosen or "No client details" is tapped explicitly. */}
      <View style={[styles.clientBar, cart.client.kind === 'UNSET' && styles.clientBarRequired]}>
        <View style={styles.clientInfo}>
          <Text style={styles.clientOverline}>{cart.client.kind === 'UNSET' ? 'Client required' : 'Client'}</Text>
          <Text style={[styles.clientName, cart.client.kind === 'UNSET' && styles.clientNameRequired]} numberOfLines={1}>
            {clientLabel ?? 'Add the client for this sale'}
          </Text>
          {statutoryLabel ? <Text style={styles.clientStatutory}>{statutoryLabel}</Text> : null}
        </View>
        <View style={styles.clientActions}>
          <Button
            title={cart.client.kind === 'UNSET' ? 'Add client' : 'Change'}
            variant={cart.client.kind === 'UNSET' ? 'primary' : 'secondary'}
            compact
            disabled={!!blocked}
            onPress={() => setDialog('client')}
          />
          {cart.client.kind === 'UNSET' ? (
            <Pressable
              accessibilityRole="button"
              disabled={!!blocked}
              hitSlop={8}
              onPress={() => cart.setClient({ kind: 'WALK_IN', clientUuid: newClientUuid(), firstName: '', lastName: '' })}
            >
              <Text style={styles.noDetails}>No client details</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {cardBlock ? <Banner kind="warning" message={cardBlock} style={styles.cardBanner} /> : null}

      <View style={styles.totals}>
        <TotalsSummary
          totals={totals}
          statutoryLabel={cart.statutory ? statutoryTypeLabel(cart.statutory.type) : undefined}
          saleDiscount={{
            value: cart.txDiscount,
            reason: cart.txDiscountReason,
            onEdit: () => setDialog('txDiscount'),
            blockedReason: saleDiscountBlocked,
          }}
        />
      </View>
      {problem && cart.lines.length > 0 ? <Text style={styles.problem}>{problem}</Text> : null}
    </View>
  );

  return (
    <View style={styles.root}>
      {blocked ? <Banner kind="danger" title={sync.subscriptionLocked ? 'Subscription locked — selling stopped' : 'Selling is paused'} message={blocked} style={styles.banner} /> : null}
      {!blocked ? <DrawerGateBanner gate={drawer} style={styles.banner} /> : null}
      {!blocked && data.error ? <Banner kind="warning" message={data.error} style={styles.banner} /> : null}
      {!sync.online && !blocked ? (
        <Banner kind="warning" message="Offline — sales are saved on this device and sent when the connection is back." style={styles.banner} />
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
        <View style={styles.spacer} />
        <Text style={styles.topLabel}>Sold By</Text>
        <Chip label={soldByName} selected={cart.soldById !== null} tone="accent" onPress={() => setDialog('soldBy')} disabled={!!blocked} />
      </View>

      <View style={[styles.body, !wide && styles.bodyStacked]}>
        <View style={wide ? styles.left : styles.leftStacked}>
          <ProductSearch
            catalog={data.catalog}
            channelId={cart.channelId}
            channelName={channelName}
            onAdd={(item) => cart.addItem(item, data.catalog?.version ?? null)}
            disabled={!!blocked || cart.channelId === null}
          />
        </View>

        <View style={wide ? styles.right : [styles.right, styles.rightStacked]} onLayout={(e) => setPanelH(e.nativeEvent.layout.height)}>
          <View style={styles.cartHeader}>
            <Text style={styles.cartTitle}>
              Cart{itemCount > 0 ? ` · ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}
            </Text>
            {cart.lines.length > 0 ? <Button title="Clear" variant="ghost" compact onPress={confirmClear} /> : null}
          </View>
          {cart.notice ? (
            <Banner kind="info" message={cart.notice} actionLabel="OK" onAction={() => cart.setNotice(null)} style={styles.banner} />
          ) : null}

          <ScrollView style={styles.lines} keyboardShouldPersistTaps="handled">
            {cart.lines.length === 0 ? <Text style={styles.empty}>Tap an item or scan a barcode to add it.</Text> : lineRows}
            {pinSummary ? null : summary}
          </ScrollView>
          {pinSummary ? summary : null}

          <Button
            title={cart.lines.length > 0 ? `Charge ${formatPeso(totals.grandTotal)}` : 'Charge'}
            variant="primary"
            onPress={() => navigation.navigate('Payment')}
            disabled={problem !== null}
            style={styles.charge}
          />
        </View>
      </View>

      <SoldByDialog
        visible={dialog === 'soldBy'}
        staff={staff}
        value={cart.soldById}
        cashier={cashier ? { userId: cashier.userId, name: cashier.name } : null}
        onPick={cart.setSoldBy}
        onClose={() => setDialog(null)}
      />
      <ClientDialog
        visible={dialog === 'client'}
        value={cart.client}
        statutory={cart.statutory}
        eligibleCount={eligibleCount}
        online={sync.online}
        onClose={() => setDialog(null)}
        onSave={(client, statutory) => {
          cart.setClient(client);
          cart.setStatutory(statutory);
          // "None" chosen for a client whose card is on record (buying for someone else) — don't re-apply it.
          setStatutoryOffFor(client.kind === 'EXISTING' && !statutory && clientHasStatutory(client.client) ? client.client.id : null);
        }}
      />
      <DiscountDialog
        visible={dialog === 'txDiscount'}
        title="Sale discount"
        base={Math.max(totals.subtotal - totals.totalItemDiscount, 0)}
        baseLabel={totals.totalItemDiscount > 0 ? 'Subtotal after item discounts' : 'Subtotal'}
        value={cart.txDiscount}
        reason={cart.txDiscountReason}
        notes={[
          'Taken off the whole sale and shared across its items.',
          'A transaction discount can’t be combined with the Senior/PWD discount.',
        ]}
        onSave={(d, reason) => cart.setTxDiscount(d, reason)}
        onClose={() => setDialog(null)}
      />
      <DiscountDialog
        visible={!!editingLine}
        title={editingLine ? `Item discount · ${editingLine.name}` : 'Item discount'}
        base={editingLine ? editingLine.quantity * chargedLineOf(cart, editingLine).unitPrice : 0}
        baseLabel={editingLine ? `Line subtotal (${editingLine.quantity} × ${formatPeso(chargedLineOf(cart, editingLine).unitPrice)})` : 'Line subtotal'}
        notes={editingLine?.scPwdEligible ? ['Senior/PWD-eligible item: applying Senior/PWD to this sale replaces this discount with the 20%.'] : undefined}
        value={editingLine?.discount ?? { value: '', mode: 'amount' }}
        onSave={(d) => editingLine && cart.setLineDiscount(editingLine.skuId, d)}
        onClose={() => setDialog(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background, padding: spacing.lg },
  banner: { marginBottom: spacing.md },
  topBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: c.primaryTint,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
  },
  topLabel: { ...t.overline, marginRight: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, flexShrink: 1 },
  spacer: { flex: 1 },
  warn: { ...t.caption, color: c.warning },
  body: { flex: 1, flexDirection: 'row', gap: spacing.lg },
  // Narrow window (portrait / phone): the search on top, the cart under it, sharing the height.
  bodyStacked: { flexDirection: 'column', gap: spacing.md },
  left: { flex: 3 },
  leftStacked: { flex: 1, minHeight: 180 },
  right: {
    flex: 2,
    minWidth: 360,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    borderTopWidth: 4,
    borderTopColor: c.primary,
    padding: spacing.lg,
    ...shadow.card,
  },
  rightStacked: { flex: 1.3, minWidth: 0, padding: spacing.md },
  cartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 40,
    marginBottom: spacing.sm,
  },
  cartTitle: { ...t.heading, color: c.primary },
  // The sale's client — required, like the web: amber until chosen, sage once set.
  clientBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
    backgroundColor: c.primaryTint,
  },
  clientActions: { alignItems: 'flex-end', gap: spacing.xs },
  // Deliberately small and quiet: skipping the client is an explicit choice, not the easy default.
  noDetails: { ...t.caption, fontSize: 12, color: c.muted, textDecorationLine: 'underline' },
  clientBarRequired: { borderColor: c.warning, backgroundColor: c.warningSoft },
  clientInfo: { flex: 1, minWidth: 0 },
  clientOverline: { ...t.overline, fontSize: 11 },
  clientName: { ...t.bodyStrong },
  clientNameRequired: { color: c.warning },
  clientStatutory: { ...t.caption, fontFamily: t.bodyStrong.fontFamily, color: c.primary },
  lines: { flex: 1 },
  empty: { ...t.body, color: c.muted, textAlign: 'center', paddingVertical: spacing.xxl },
  cardBanner: { marginTop: spacing.sm },
  totals: { marginTop: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: c.border },
  problem: { ...t.caption, color: c.danger, marginBottom: spacing.sm },
  // Same height as the checkout actions on Payment and Receipt.
  charge: { minHeight: 56, marginTop: spacing.sm },
}));
