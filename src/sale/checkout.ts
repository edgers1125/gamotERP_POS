// Records the sale: builds the SalePayload from the cart + tender and hands it to `localStore.recordSale`, which takes
// the device's next invoice number, signs and saves the sale and enqueues its SALE op in ONE local transaction (so a
// printed number is never lost, reused or skipped). Then a sync is kicked off (fire and forget — offline is fine).
import type { PosApprovalKind, PosApprover, PosPaymentMethod, SaleClientPayload, SaleLinePayload, SalePayload } from '@pos-api/contract';
import { normalizePhone } from '@shared/phone';
import type { LocalSale } from '../contracts';
import { api } from '../api/client';
import { cashierSession } from '../auth/cashierSession';
import { appVersionName } from '../config/runtime';
import { localStore } from '../db/localStore';
import { syncEngine } from '../sync/syncEngine';
import { cartTotals, chargedLineOf, discountNeedsApproval, isStatutoryLine, type CartState } from './cart';
import { promoPayloadFields, promosCurrentAt } from './promos';
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
function clientPayload(state: CartState): SaleClientPayload | null {
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
}): Promise<LocalSale> {
  const { state, payments, methods, approval, online } = input;
  const soldAt = input.soldAt ?? new Date();
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
    pricing_channel_id: state.channelId,
    client: clientPayload(state),
    lines,
    transaction_discount_amount: txHas ? (tx.percent != null ? '0.00' : money(tx.amount)) : '0.00',
    transaction_discount_percent: txHas && tx.percent != null ? percentText(tx.percent) : null,
    transaction_discount_reason: txHas ? state.txDiscountReason.trim() || null : null,
    discount_approval: needsApproval && approval ? { approved_by_user_id: approval.approvedByUserId, approval_code: approval.approvalCode } : null,
    statutory_discount: state.statutory ? statutoryPayload(state.statutory) : null,
    payments: paymentsPayload(payments, methods),
    note: state.note.trim() || null,
    totals: totalsPayload(totals),
  };

  const sale = await localStore.recordSale((invoiceSeq) => ({ ...base, invoice_seq: invoiceSeq, sold_at: soldAt.toISOString() }));

  rememberReceiptSnapshot(sale.client_uuid, {
    lines: state.lines.map((l) => ({ skuId: l.skuId, name: l.name, isVatable: l.isVatable, scPwdEligible: l.scPwdEligible, promoName: l.promo?.name ?? null })),
    customerName: saleClientName(state),
    paymentMethods: methods,
    cashierName: cashier.name,
    soldByName: (await localStore.getBootstrap().catch(() => null))?.sales_staff.find((s) => s.id === state.soldById)?.name ?? null,
  });
  syncEngine.syncNow().catch(() => undefined);
  return sale;
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
