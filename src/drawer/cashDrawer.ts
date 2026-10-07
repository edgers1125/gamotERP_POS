// Cash drawer (GamotERP docs/plans/sales-side-tables-and-cash-drawer.md §B; CLAUDE.md "Cash drawer"): the local types
// and the ONE expected-cash calculation, used both by the Cash drawer screen and for DRAWER_CLOSE's
// `device_expected_cash`. Pure (no DB, no React) — localStore reads the rows and calls `drawerTally`.
//
// Expected cash = opening float
//               + Σ CASH payment amounts of this device's sales in [opened_at, until) that are not voided
//                 (payment amounts are already net of change)
//               − Σ CASH paid back by refunds made on this device in that window (refunds copy the sale's payments)
//               + Σ CASH_IN − Σ CASH_OUT
// The server computes its own figure (the truth) and flags a difference — this one is only for the device's display.
import type { DrawerMovementKind, PosPaymentMethod, SalePayload } from '@pos-api/contract';

export type DrawerSyncState = 'PENDING' | 'RECORDED' | 'REJECTED';

export interface LocalDrawerSession {
  client_uuid: string; // = the DRAWER_OPEN op's client_uuid
  device_id: number;
  pos_terminal_id: number;
  terminal_name: string;
  opened_at: string;
  opened_by: { id: number; name: string };
  opening_float: string;
  status: 'OPEN' | 'CLOSED';
  sync_status: DrawerSyncState;
  closed_at: string | null;
  closed_by: { id: number; name: string } | null;
  counted_cash: string | null;
  expected_cash: string | null; // what this device computed at close
  close_note: string | null;
  close_sync_status: DrawerSyncState | null;
}

export interface LocalDrawerMovement {
  client_uuid: string;
  session_client_uuid: string;
  kind: DrawerMovementKind;
  amount: string;
  reason: string;
  user: { id: number; name: string };
  occurred_at: string;
  sync_status: DrawerSyncState;
}

/** A sale as the tally needs it: its signed payload + the payment methods snapshotted on its receipt (if any). */
export interface TallySale {
  payload: SalePayload;
  snapshotMethods?: PosPaymentMethod[] | null;
}

export interface DrawerTallyInput {
  openingFloat: string;
  /** Sales already filtered to the ones that count (in the window, not voided, not rejected). */
  sales: TallySale[];
  /** Refunds in the window; `sale` null = the refunded sale wasn't rung up on this device (cash unknown here). */
  refunds: { sale: TallySale | null }[];
  movements: { kind: DrawerMovementKind; amount: string }[];
  /** The terminal's payment methods (bootstrap, else catalog) — decides which payments are CASH. */
  knownMethods: PosPaymentMethod[];
}

/** All figures in pesos (2 decimals, computed in whole centavos). */
export interface DrawerTally {
  openingFloat: number;
  cashSales: number;
  salesCount: number;
  cashRefunds: number; // ≤ 0
  refundsCount: number;
  /** Refunds of sales from another device — their cash can't be known here (the server's figure includes them). */
  uncountedRefunds: number;
  cashIn: number;
  cashOut: number;
  expected: number;
}

const cents = (s: string | null | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const pesos = (c: number): number => c / 100;

/** Cash paid on a sale, in centavos. A method's kind comes from the terminal's list, else the sale's receipt snapshot;
 * a method known to neither counts as cash when the line carries cash received (only CASH lines do). */
function saleCashCents(sale: TallySale, known: Map<number, PosPaymentMethod['kind']>): number {
  let snapshot: Map<number, PosPaymentMethod['kind']> | null = null;
  let total = 0;
  for (const p of sale.payload.payments ?? []) {
    let kind = known.get(p.payment_method_id);
    if (kind === undefined) {
      snapshot ??= new Map((sale.snapshotMethods ?? []).map((m) => [m.id, m.kind]));
      kind = snapshot.get(p.payment_method_id);
    }
    const isCash = kind !== undefined ? kind === 'CASH' : p.tendered_amount !== null && p.tendered_amount !== undefined;
    if (isCash) total += cents(p.amount);
  }
  return total;
}

export function drawerTally(input: DrawerTallyInput): DrawerTally {
  const known = new Map(input.knownMethods.map((m) => [m.id, m.kind]));
  const float = cents(input.openingFloat);
  let sales = 0;
  for (const s of input.sales) sales += saleCashCents(s, known);
  let refunds = 0;
  let uncounted = 0;
  for (const r of input.refunds) {
    if (r.sale) refunds -= saleCashCents(r.sale, known);
    else uncounted++;
  }
  let cashIn = 0;
  let cashOut = 0;
  for (const m of input.movements) {
    if (m.kind === 'CASH_IN') cashIn += cents(m.amount);
    else cashOut += cents(m.amount);
  }
  return {
    openingFloat: pesos(float),
    cashSales: pesos(sales),
    salesCount: input.sales.length,
    cashRefunds: pesos(refunds),
    refundsCount: input.refunds.length,
    uncountedRefunds: uncounted,
    cashIn: pesos(cashIn),
    cashOut: pesos(cashOut),
    expected: pesos(float + sales + refunds + cashIn - cashOut),
  };
}

/** Does a local sale count toward the drawer? Not if the server rejected it, nor if it was voided (unless the void
 * itself was rejected — then the server still has the sale). Same rule the server applies to recorded sales. */
export function saleCountsInDrawer(r: { sync_status: string; voided_at: string | null; void_sync_status: string | null }): boolean {
  if (r.sync_status === 'REJECTED') return false;
  return !r.voided_at || r.void_sync_status === 'REJECTED';
}

/** Counted − expected in centavos → the over/short label and tone. */
export function varianceOf(counted: number, expected: number): { amount: number; label: 'Balanced' | 'Short' | 'Over'; tone: 'success' | 'danger' | 'warning' } {
  const v = Math.round(counted * 100) - Math.round(expected * 100);
  if (v === 0) return { amount: 0, label: 'Balanced', tone: 'success' };
  return v < 0 ? { amount: v / 100, label: 'Short', tone: 'danger' } : { amount: v / 100, label: 'Over', tone: 'warning' };
}

export const DRAWER_REASON_MAX = 200;
export const DRAWER_NOTE_MAX = 500;
/** Largest amount the drawer screens accept (Decimal(12,2) on the server). */
export const DRAWER_MAX_AMOUNT = 9_999_999_999.99;

export const DRAWER_CLOSED_MESSAGE = 'Open the cash drawer to start selling.';

/** Why selling is blocked by the drawer (no open session on THIS terminal), or null. */
export function drawerSellProblem(open: { pos_terminal_id: number; terminal_name: string } | null, terminalId: number | null): string | null {
  if (!open) return DRAWER_CLOSED_MESSAGE;
  if (terminalId !== null && open.pos_terminal_id !== terminalId) {
    return `The open cash drawer belongs to terminal ${open.terminal_name}. Close it, then open the drawer for this terminal to sell.`;
  }
  return null;
}
