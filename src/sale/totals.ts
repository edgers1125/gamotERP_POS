// The cart's totals — ONLY through the backend's shared pricing code (@shared/material-issuance-pricing, which uses
// @shared/discount), never re-implemented here: the server recomputes every synced sale with the same functions and
// flags TOTALS_MISMATCH if the device's figures differ.
import {
  computeMaterialIssuanceTotals,
  resolveMaterialIssuanceDiscounts,
  type MaterialIssuanceTotals,
} from '@shared/material-issuance-pricing';
import type { DiscountInput } from '@shared/discount';
import type { SalePayload } from '@pos-api/contract';
import { money } from './money';

export type DiscountMode = 'amount' | 'percent';

/** A discount as typed: a peso amount or a percentage (0–100). */
export interface DiscountDraft {
  value: string;
  mode: DiscountMode;
}

export const NO_DISCOUNT: DiscountDraft = { value: '', mode: 'amount' };

/** The shared DiscountInput for a typed discount (percent clamped to 0–100; junk → none). */
export function discountInput(d: DiscountDraft): DiscountInput {
  const n = Number(d.value.trim());
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (d.mode === 'percent') return v > 0 ? { amount: 0, percent: Math.min(v, 100) } : { amount: 0, percent: null };
  return { amount: v, percent: null };
}

export function hasDiscount(d: DiscountDraft): boolean {
  const i = discountInput(d);
  return i.percent != null ? i.percent > 0 : i.amount > 0;
}

export interface TotalsLineInput {
  quantity: number;
  unitPrice: number;
  isVatable: boolean;
  /** Senior/PWD applies to this line (the sale has a statutory discount and the SKU is sc_pwd_eligible). */
  isStatutory: boolean;
  /** A statutory line's rate (shared pricing; default 20 %). 0 = a Senior/PWD line of a promo item charged the PROMO
   * price (VAT-exempt, no 20 % — src/sale/promos.ts `chargedLine`). */
  statutoryDiscountRate?: number;
  itemDiscount: DiscountDraft;
}

export interface SaleTotals extends MaterialIssuanceTotals {
  /** Peso item discount per line, as resolved by the shared code (0 on statutory lines). */
  itemDiscountAmounts: number[];
}

/**
 * Resolves the discounts (₱ or %) exactly as the server does and prices the cart. A statutory line never carries an
 * item discount and, with any statutory line, the transaction discount is 0 (no double discount) — the caller already
 * clears those, this only makes sure nothing slips through.
 */
export function computeCartTotals(lines: TotalsLineInput[], transactionDiscount: DiscountDraft, statutoryOn: boolean): SaleTotals {
  const { itemDiscountAmounts, transactionDiscountAmount } = resolveMaterialIssuanceDiscounts(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      itemDiscount: l.isStatutory ? { amount: 0, percent: null } : discountInput(l.itemDiscount),
    })),
    statutoryOn ? { amount: 0, percent: null } : discountInput(transactionDiscount),
  );
  const totals = computeMaterialIssuanceTotals(
    lines.map((l, idx) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      itemDiscountAmount: itemDiscountAmounts[idx]!,
      isVatable: l.isVatable,
      isStatutory: l.isStatutory,
      ...(l.statutoryDiscountRate !== undefined ? { statutoryDiscountRate: l.statutoryDiscountRate } : {}),
    })),
    transactionDiscountAmount,
  );
  return { ...totals, itemDiscountAmounts };
}

/** The payload's `totals` block (strings, 2 decimals). */
export function totalsPayload(t: MaterialIssuanceTotals): SalePayload['totals'] {
  return {
    subtotal: money(t.subtotal),
    total_item_discount: money(t.totalItemDiscount),
    transaction_discount_amount: money(t.transactionDiscountAmount),
    total_statutory_discount: money(t.totalStatutoryDiscount),
    vat_exempt_sales: money(t.vatExemptSales),
    total_vat: money(t.totalVat),
    grand_total: money(t.grandTotal),
  };
}

/** Re-prices a recorded payload (receipt / reprint) with the same shared code. `flags` per sku_id from the catalog. */
export function computePayloadTotals(
  payload: SalePayload,
  flags: (skuId: number) => { isVatable: boolean; scPwdEligible: boolean },
): SaleTotals {
  const statutoryOn = payload.statutory_discount != null;
  const pct = (s: string | null | undefined) => (s == null || s === '' ? '' : s);
  return computeCartTotals(
    payload.lines.map((l) => {
      const f = flags(l.sku_id);
      const percent = pct(l.item_discount_percent);
      return {
        quantity: l.quantity,
        unitPrice: Number(l.unit_price),
        isVatable: f.isVatable,
        isStatutory: statutoryOn && f.scPwdEligible,
        // A Senior/PWD line of a promo item where the cashier chose the promo: VAT-exempt, no 20 % (as the server prices it).
        ...(statutoryOn && f.scPwdEligible && l.promo_vs_scpwd === 'PROMO' ? { statutoryDiscountRate: 0 } : {}),
        itemDiscount: percent !== '' ? { value: percent, mode: 'percent' } : { value: l.item_discount_amount ?? '', mode: 'amount' },
      };
    }),
    pct(payload.transaction_discount_percent) !== ''
      ? { value: payload.transaction_discount_percent!, mode: 'percent' }
      : { value: payload.transaction_discount_amount ?? '', mode: 'amount' },
    statutoryOn,
  );
}
