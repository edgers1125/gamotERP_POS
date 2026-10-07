// What the customer display shows, driven from the cart (see CLAUDE.md "Customer display"):
//   * cart has lines → showCart (brand left, order breakdown right); the Payment screen adds cash received / change;
//   * a sale just completed (Receipt screen) → showThankYou for ~8 s, then back to whatever the cart says;
//   * empty cart → showIdle (the branch's ads full-screen, or the brand).
// Every figure comes from `cartTotals` (the shared pricing code the cart and TotalsSummary use) and is only formatted
// here — no money is computed. The client is shown by first name only (privacy). All calls are no-ops when the native
// module isn't built in (Expo Go) or no second display is connected.
import PosDisplay from '../../modules/pos-display';
import type { PosDisplayCartState, PosDisplayRow, PosDisplayThankYouState } from '../../modules/pos-display';
import { cartTotals, chargedLineOf, isStatutoryLine, useCart, type CartState, type SaleClient } from '../sale/cart';
import { formatPeso, round2 } from '../sale/money';
import { statutoryTypeLabel } from '../sale/statutory';
import { displayService } from './displayService';

const THROTTLE_MS = 100;
const THANK_YOU_MS = 8_000;

let payment: { tendered: number; change: number } | null = null;
let thankYouTimer: ReturnType<typeof setTimeout> | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPushAt = 0;
let lastSent: string | null = null;

function firstName(client: SaleClient): string | null {
  const name =
    client.kind === 'EXISTING' ? client.client.first_name : client.kind === 'WALK_IN' || client.kind === 'NEW' ? client.firstName : null;
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first !== '' ? first : null;
}

function cartState(s: CartState): PosDisplayCartState {
  const totals = cartTotals(s);
  const statutoryLabel = s.statutory ? statutoryTypeLabel(s.statutory.type) : 'Senior/PWD';
  const lines = s.lines.map((l, i) => {
    const computed = totals.lines[i];
    const discounts: PosDisplayRow[] = [];
    // A promo-priced line reads like the receipt: qty × regular price = regular amount, then "Promo: <name> −x".
    const charged = chargedLineOf(s, l);
    const promo = charged.promoApplied && l.promo ? l.promo : null;
    if (promo) discounts.push({ label: `Promo: ${promo.name}`, value: formatPeso(-round2(l.quantity * (l.unitPrice - charged.unitPrice))) });
    const itemDiscount = totals.itemDiscountAmounts[i] ?? 0;
    if (itemDiscount > 0) {
      discounts.push({
        label: l.discount.mode === 'percent' ? `Discount (${l.discount.value}%)` : 'Discount',
        value: formatPeso(-itemDiscount),
      });
    }
    if (computed && isStatutoryLine(s, l) && computed.statutoryDiscountAmount > 0) {
      discounts.push({ label: `${statutoryLabel} 20%`, value: formatPeso(-computed.statutoryDiscountAmount) });
    }
    return {
      name: l.name,
      detail: `${l.quantity} × ${formatPeso(promo ? l.unitPrice : charged.unitPrice)}`,
      amount: formatPeso(promo ? round2(l.quantity * l.unitPrice) : (computed?.lineSubtotal ?? 0)),
      discounts,
    };
  });

  // Same rows, same order as TotalsSummary.
  const rows: PosDisplayCartState['totals'] = [{ label: 'Subtotal', value: formatPeso(totals.subtotal), tone: 'normal' }];
  if (totals.totalItemDiscount > 0) rows.push({ label: 'Item discounts', value: formatPeso(-totals.totalItemDiscount), tone: 'discount' });
  if (totals.transactionDiscountAmount > 0) rows.push({ label: 'Sale discount', value: formatPeso(-totals.transactionDiscountAmount), tone: 'discount' });
  if (totals.totalStatutoryDiscount > 0) rows.push({ label: `${statutoryLabel} 20%`, value: formatPeso(-totals.totalStatutoryDiscount), tone: 'discount' });
  if (totals.vatExemptSales > 0) rows.push({ label: 'VAT-exempt sales', value: formatPeso(totals.vatExemptSales), tone: 'muted' });
  rows.push({ label: 'VAT (12%)', value: formatPeso(totals.totalVat), tone: 'muted' });

  const first = firstName(s.client);
  const count = s.lines.reduce((n, l) => n + l.quantity, 0);
  return {
    heading: `Your order · ${count} item${count === 1 ? '' : 's'}`,
    greeting: first ? `Hi, ${first}!` : null,
    lines,
    totals: rows,
    grandTotalLabel: 'TOTAL',
    grandTotal: formatPeso(totals.grandTotal),
    payment: payment
      ? [
          { label: 'Cash received', value: formatPeso(payment.tendered) },
          { label: 'Change', value: formatPeso(payment.change), accent: true },
        ]
      : [],
  };
}

/** Sends the cart (or idle) now — unless the thank-you is still up and the cart is empty. */
function pushNow(): void {
  if (!PosDisplay) return;
  lastPushAt = Date.now();
  const s = useCart.getState();
  if (thankYouTimer) {
    if (s.lines.length === 0) return;
    // The next customer's first item ends the thank-you early.
    clearTimeout(thankYouTimer);
    thankYouTimer = null;
    lastSent = null;
  }
  if (s.lines.length === 0) {
    if (lastSent === 'idle') return;
    lastSent = 'idle';
    PosDisplay.showIdle();
    return;
  }
  const json = JSON.stringify(cartState(s));
  if (json === lastSent) return;
  lastSent = json;
  PosDisplay.showCart(json);
}

/** Throttled (~100 ms, leading + trailing) so fast scanning doesn't flood the bridge. */
function schedule(): void {
  if (!PosDisplay || throttleTimer) return;
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastPushAt));
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    pushNow();
  }, wait);
}

export const customerDisplay = {
  /** Starts following the cart; returns the stop function. Mounted once (useCustomerDisplay in App.tsx). */
  start(): () => void {
    if (!PosDisplay) return () => undefined;
    const module = PosDisplay;
    void displayService.loadCached();
    const unsubscribeCart = useCart.subscribe(schedule);
    // A monitor was plugged in: the module re-renders its last state itself; re-send ours anyway in case it's newer.
    const sub = module.addListener('onDisplayChange', () => {
      lastSent = null;
      void displayService.loadCached();
      schedule();
    });
    lastSent = null;
    pushNow();
    return () => {
      unsubscribeCart();
      sub.remove();
      if (throttleTimer) clearTimeout(throttleTimer);
      throttleTimer = null;
    };
  },

  /** Payment screen: cash received + change once the cash line is valid (null clears it). */
  setPayment(next: { tendered: number; change: number } | null): void {
    const same = next === payment || (next && payment && next.tendered === payment.tendered && next.change === payment.change);
    if (same) return;
    payment = next;
    schedule();
  },

  /** Receipt screen, fresh sale: "Thank you" for ~8 s, then back to the cart state (normally idle). */
  showThankYou(info: { total: number | string; change: number | string | null; invoiceNumber: string }): void {
    if (!PosDisplay) return;
    payment = null;
    const rows: PosDisplayRow[] = [{ label: 'Total paid', value: formatPeso(info.total), accent: true }];
    if (info.change !== null && Number(info.change) > 0) rows.push({ label: 'Change', value: formatPeso(info.change), accent: true });
    rows.push({ label: 'Receipt no.', value: info.invoiceNumber });
    const state: PosDisplayThankYouState = { title: 'Thank you!', subtitle: 'Please come again.', rows };
    if (thankYouTimer) clearTimeout(thankYouTimer);
    thankYouTimer = setTimeout(() => {
      thankYouTimer = null;
      lastSent = null;
      pushNow();
    }, THANK_YOU_MS);
    lastSent = null;
    PosDisplay.showThankYou(JSON.stringify(state));
  },
};
