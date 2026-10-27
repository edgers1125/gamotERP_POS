// Records the sale: builds the SalePayload from the cart + tender and hands it to `localStore.recordSale`, which takes
// the device's next invoice number, signs and saves the sale and enqueues its SALE op in ONE local transaction (so a
// printed number is never lost, reused or skipped). Then a sync is kicked off (fire and forget — offline is fine).
import type { PosApprovalKind, PosApprover, PosClockReport, PosPaymentMethod, PosRxIssue, SaleClientPayload, SaleLinePayload, SalePayload } from '@pos-api/contract';
import { normalizePhone } from '@shared/phone';
import type { LocalSale } from '../contracts';
import { api } from '../api/client';
import { cashierSession } from '../auth/cashierSession';
import { appVersionName } from '../config/runtime';
import { stampClock } from '../device/clockStamp';
import { localStore } from '../db/localStore';
import { syncEngine } from '../sync/syncEngine';
import { cartTotals, chargedLineOf, discountNeedsApproval, isStatutoryLine, rxLinesOf, type CartState } from './cart';
import { useDoctors } from './doctors';
import { cartNeedsRx, localRxIssues, prescriptionCheckRequest, prescriptionPayload, rxPatientOf, rxSaleDay } from './prescription';
import { promoPayloadFields, promosCurrentAt } from './promos';
import { amountDueOf, billingPayload, billingProblem, buyerTinOf, withholdingFigures } from './billing';
import { discountInput, totalsPayload } from './totals';
import { money } from './money';
import { paymentsPayload, type PaymentDraft } from './payments';
import { clientName, statutoryPayload } from './statutory';
import { rememberReceiptSnapshot } from './receipt';

export function appVersion(): string {
  return appVersionName();
}

export interface Approval {
  approvedByUserId: number;
  approvalCode: string;
}

function percentText(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// EXISTING → client_id. NEW → a registered client (name + phone, contactless false) — also on a Senior/PWD sale, where
// the server writes the card onto the client it finds/registers by phone. (A NEW client without a phone — only from
// an older cart — goes as a named contactless one.) WALK_IN ("No client details") → contactless, carrying the
// optional names; with no name at all, no client (an anonymous sale).
export function clientPayload(state: Pick<CartState, 'client'>): SaleClientPayload | null {
  const c = state.client;
  if (c.kind === 'EXISTING') return { client_id: c.client.id };
  if (c.kind === 'NEW') {
    const phone = normalizePhone(c.phone); // canonical (`@shared/phone`), as the server stores and matches it
    const registered = phone !== '';
    return {
      new_client: {
        client_uuid: c.clientUuid,
        first_name: c.firstName.trim() || null,
        middle_name: c.middleName.trim() || null,
        last_name: c.lastName.trim() || null,
        phone_number: registered ? phone : null,
        contactless: !registered,
      },
    };
  }
  if (c.kind === 'WALK_IN' && (c.firstName.trim() !== '' || c.lastName.trim() !== '')) {
    return {
      new_client: {
        client_uuid: c.clientUuid,
        first_name: c.firstName.trim() || null,
        middle_name: null,
        last_name: c.lastName.trim() || null,
        phone_number: null,
        contactless: true,
      },
    };
  }
  return null;
}

export function saleClientName(state: CartState): string | null {
  const c = state.client;
  if (c.kind === 'EXISTING') return clientName(c.client);
  if (c.kind === 'NEW' || c.kind === 'WALK_IN') {
    const n = [c.firstName, c.kind === 'NEW' ? c.middleName : '', c.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
    return n || null;
  }
  return null;
}

/** Thrown when a store promo started or ended since the cart was last re-checked (the cart must be re-checked first). */
export class PromoChangedError extends Error {}

/**
 * Builds and records the sale. `online` = the sync engine's view right now (SalePayload.offline = !online).
 * `soldAt` = the instant the cart's promos were last re-checked (PaymentScreen: `refreshPromos(soldAt)` right before) —
 * it goes out as sold_at, so the server judges each promo at the same moment the device did. Default: now.
 * Throws with a user-facing message when it can't be recorded (no cashier, no catalog…).
 */
export async function completeSale(input: {
  state: CartState;
  payments: PaymentDraft[];
  methods: PosPaymentMethod[];
  approval: Approval | null;
  online: boolean;
  soldAt?: Date;
  /** The clock report taken together with `soldAt` (src/device/clockStamp.ts; absent on an old native build). Without
   * `soldAt` both are stamped here. */
  clock?: PosClockReport;
}): Promise<LocalSale> {
  const { state, payments, methods, approval, online } = input;
  // sold_at = device clock + the learned server offset (PosClockReport); the report rides along in the signed payload.
  const stamp = input.soldAt ? { at: input.soldAt, clock: input.clock } : await stampClock();
  const soldAt = stamp.at;
  const cashier = cashierSession.current();
  if (!cashier) throw new Error('Sign in as a cashier first.');
  if (state.channelId === null) throw new Error('Choose the pricing channel.');
  if (state.soldById === null) throw new Error('Choose who sold it (Sold By).');
  const catalog = await localStore.getCatalog();
  if (!catalog) throw new Error('The price list isn’t loaded yet — connect once to download it.');
  // Last guard: every line's promo is the one in force at sold_at (the screen re-checks just before calling this).
  if (!promosCurrentAt(state.lines, state.promos, soldAt)) {
    throw new PromoChangedError('A store promo started or ended just now — check the prices and the amount due, then complete the sale again.');
  }

  const totals = cartTotals(state);
  const needsApproval = discountNeedsApproval(totals);
  if (needsApproval && !approval) throw new Error('The discount needs an approver and their code.');
  const statutoryOn = state.statutory !== null;
  // "Bill to company" (BIR Phase 1): the withholding on these totals (shared maths); none = old behaviour, no new fields.
  const billProblem = billingProblem(state.billTo, totals);
  if (billProblem) throw new Error(billProblem);
  const billing = withholdingFigures(totals, state.billTo, state.pricesIncludeVat);
  // Prescription (Rx step): the local checks on the sale day (the online check ran on the screen before this).
  const rxIssue = localPrescriptionIssues(state, soldAt)[0];
  if (rxIssue) throw new Error(rxIssue.message);

  const lines: SaleLinePayload[] = state.lines.map((l) => {
    const statutoryLine = isStatutoryLine(state, l);
    // unit_price = as charged (the promo price when the promo prices it); a promo line also carries promo_id, the regular
    // price it was taken off and, on a Senior/PWD sale, the cashier's choice (contract SaleLinePayload).
    const line: SaleLinePayload = {
      sku_id: l.skuId,
      quantity: l.quantity,
      unit_price: chargedLineOf(state, l).unitPriceText,
      ...promoPayloadFields(l, statutoryLine),
    };
    if (!statutoryLine) {
      const d = discountInput(l.discount);
      if (d.percent != null && d.percent > 0) {
        line.item_discount_amount = '0.00';
        line.item_discount_percent = percentText(d.percent);
      } else if (d.amount > 0) {
        line.item_discount_amount = money(d.amount);
        line.item_discount_percent = null;
      }
    }
    return line;
  });
  const tx = statutoryOn ? { amount: 0, percent: null } : discountInput(state.txDiscount);
  const txHas = (tx.percent ?? 0) > 0 || tx.amount > 0;
  const catalogVersion = state.catalogVersion ?? catalog.version;

  const base: Omit<SalePayload, 'invoice_seq' | 'sold_at'> = {
    cashier_user_id: cashier.userId,
    sold_by_user_id: state.soldById,
    catalog_version: catalogVersion,
    app_version: appVersion(),
    offline: !online,
    clock: stamp.clock,
    pricing_channel_id: state.channelId,
    client: clientPayload(state),
    lines,
    transaction_discount_amount: txHas ? (tx.percent != null ? '0.00' : money(tx.amount)) : '0.00',
    transaction_discount_percent: txHas && tx.percent != null ? percentText(tx.percent) : null,
    prices_include_vat: state.pricesIncludeVat,
    transaction_discount_reason: txHas ? state.txDiscountReason.trim() || null : null,
    discount_approval: needsApproval && approval ? { approved_by_user_id: approval.approvedByUserId, approval_code: approval.approvalCode } : null,
    statutory_discount: state.statutory ? statutoryPayload(state.statutory) : null,
    prescription: prescriptionPayload(state.rx, rxLinesOf(state), useDoctors.getState().items),
    ...billingPayload(state.billTo, billing),
    payments: paymentsPayload(payments, methods),
    note: state.note.trim() || null,
    totals: totalsPayload(totals),
  };

  const sale = await localStore.recordSale((invoiceSeq) => ({ ...base, invoice_seq: invoiceSeq, sold_at: soldAt.toISOString() }));

  rememberReceiptSnapshot(sale.client_uuid, {
    lines: state.lines.map((l) => ({ skuId: l.skuId, name: l.name, isVatable: l.isVatable, scPwdEligible: l.scPwdEligible, promoName: l.promo?.name ?? null })),
    customerName: saleClientName(state),
    buyer: state.billTo ? { name: state.billTo.company.name, address: state.billTo.company.address.trim() || null, tin: buyerTinOf(state.billTo) } : null,
    paymentMethods: methods,
    cashierName: cashier.name,
    soldByName: (await localStore.getBootstrap().catch(() => null))?.sales_staff.find((s) => s.id === state.soldById)?.name ?? null,
  });
  syncEngine.syncNow().catch(() => undefined);
  return sale;
}

/** The Rx step's local checks for the cart as it stands, on the Manila day of `at` ([] = fine or no Rx line). */
export function localPrescriptionIssues(state: CartState, at: Date = new Date()): PosRxIssue[] {
  return localRxIssues({
    lines: rxLinesOf(state),
    patient: rxPatientOf(state.client, state.statutory),
    draft: state.rx,
    doctors: useDoctors.getState().items,
    today: rxSaleDay(at),
  });
}

export type PrescriptionCheckOutcome =
  | { kind: 'ok' } // no Rx line, or the server found nothing
  | { kind: 'issues'; issues: PosRxIssue[]; local: boolean } // stay on the Rx step
  | { kind: 'unchecked' } // offline / server unreachable: the local checks passed — the server re-checks at sync
  | { kind: 'error'; message: string }; // the server refused the request itself (400 — e.g. refresh the price list)

/** Before charging: the local checks, then — online with an online cashier — POST /pos/prescriptions/check (the web's
 * rules, last word). Never throws. */
export async function checkCartPrescription(state: CartState, online: boolean): Promise<PrescriptionCheckOutcome> {
  const lines = rxLinesOf(state);
  if (!cartNeedsRx(lines)) return { kind: 'ok' };
  const local = localPrescriptionIssues(state);
  if (local.length > 0) return { kind: 'issues', issues: local, local: true };
  if (!online || !cashierSession.isOnlineSession()) return { kind: 'unchecked' };
  try {
    const res = await api.checkPrescription(
      prescriptionCheckRequest({
        client: clientPayload(state),
        statutory: state.statutory ? statutoryPayload(state.statutory) : null,
        lines,
        prescription: prescriptionPayload(state.rx, lines, useDoctors.getState().items),
      }),
    );
    return res.ok || res.issues.length === 0 ? { kind: 'ok' } : { kind: 'issues', issues: res.issues, local: false };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    if (status === 0 || status >= 500) return { kind: 'unchecked' };
    return { kind: 'error', message: e instanceof Error ? e.message : 'The prescription couldn’t be checked.' };
  }
}

/** Eligible co-signers: the cached list, refreshed (and re-cached) from the server when an online session exists. */
export async function loadApprovers(kind: PosApprovalKind, online: boolean): Promise<PosApprover[]> {
  const cached = await localStore.getApprovers(kind).catch(() => [] as PosApprover[]);
  if (!online || cashierSession.current()?.mode !== 'ONLINE') return cached;
  try {
    const fresh = await api.approvers(kind);
    await localStore.saveApprovers(kind, fresh).catch(() => undefined);
    return fresh;
  } catch {
    return cached;
  }
}
