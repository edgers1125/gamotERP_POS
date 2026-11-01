// The cart's totals — ONLY through the backend's shared pricing code (@shared/material-issuance-pricing, which uses
// @shared/discount), never re-implemented here: the server recomputes every synced sale with the same functions and
// flags TOTALS_MISMATCH if the device's figures differ.
import {
  computeMaterialIssuanceTotals,
  resolveMaterialIssuanceDiscounts,
  type MaterialIssuanceTotals,
} from '@shared/material-issuance-pricing';
import type { DiscountInput } from '@shared/discount';
import { assignStatutoryLines, DEFAULT_STATUTORY_RULES, type StatutoryType } from '@shared/statutory-rules';
import type { SalePayload, SaleStatutoryPayload } from '@pos-api/contract';
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
  /** A statutory card applies to this line (cart.ts `lineStatutoryType` — the shared line → card rule). */
  isStatutory: boolean;
  /** A statutory line's rate as a fraction (the card type's rule; shared pricing default 20 %). 0 = a statutory line of
   * a promo item charged the PROMO price (no rate off, the type's VAT treatment — src/sale/promos.ts `chargedLine`). */
  statutoryDiscountRate?: number;
  /** A statutory line's VAT treatment (the card type's rule; default true = VAT-exempt like Senior/PWD). false = NAAC /
   * Medal of Valor by default: the rate off the amount as shown, VAT on the rest. */
  statutoryVatExempt?: boolean;
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
export function computeCartTotals(
  lines: TotalsLineInput[],
  transactionDiscount: DiscountDraft,
  statutoryOn: boolean,
  pricesIncludeVat: boolean,
): SaleTotals {
  // VAT-inclusive mode (a VAT-registered company, `pricesIncludeVatOf`): unit prices stay BEFORE VAT; the shared code
  // shows/charges vatable lines at round(price × 1.12), discounts off those, VAT taken out once per receipt.
  const mode = { pricesIncludeVat };
  const { itemDiscountAmounts, transactionDiscountAmount } = resolveMaterialIssuanceDiscounts(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      isVatable: l.isVatable,
      itemDiscount: l.isStatutory ? { amount: 0, percent: null } : discountInput(l.itemDiscount),
    })),
    statutoryOn ? { amount: 0, percent: null } : discountInput(transactionDiscount),
    mode,
  );
  const totals = computeMaterialIssuanceTotals(
    lines.map((l, idx) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      itemDiscountAmount: itemDiscountAmounts[idx]!,
      isVatable: l.isVatable,
      isStatutory: l.isStatutory,
      ...(l.statutoryDiscountRate !== undefined ? { statutoryDiscountRate: l.statutoryDiscountRate } : {}),
      ...(l.statutoryVatExempt !== undefined ? { statutoryVatExempt: l.statutoryVatExempt } : {}),
    })),
    transactionDiscountAmount,
    mode,
  );
  return { ...totals, itemDiscountAmounts };
}

/** A new sale's pricing mode: the cached bootstrap's receipt.vat_registered (field absent = registered, the server's
 * default). Never derived from anything else (backend docs/claude/pos-android.md "VAT-inclusive prices"). */
export function pricesIncludeVatOf(bootstrap: { receipt?: unknown } | null | undefined): boolean {
  const r = (bootstrap?.receipt ?? null) as { vat_registered?: unknown } | null;
  return r !== null && r.vat_registered !== false;
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

/** A recorded line's statutory card (null = an ordinary line): its type and what the device charged for that type. */
export interface PayloadStatutoryLine {
  type: StatutoryType;
  ratePercent: number;
  vatExempt: boolean;
}

/** The payload's cards in order: `statutory_cards` when sent (several cards), else the single `statutory_discount`. */
export function payloadStatutoryCards(payload: Pick<SalePayload, 'statutory_cards' | 'statutory_discount'>): { cards: SaleStatutoryPayload[]; explicit: boolean } {
  if (payload.statutory_cards && payload.statutory_cards.length > 0) return { cards: payload.statutory_cards, explicit: true };
  return { cards: payload.statutory_discount ? [payload.statutory_discount] : [], explicit: false };
}

/** A recorded card's rule: the rate / VAT it carries (what the device charged); absent (an older app) = the law's
 * defaults (Senior / PWD 20 %, VAT-exempt — the only types an older app could send). */
export function payloadCardRule(card: SaleStatutoryPayload): { ratePercent: number; vatExempt: boolean } {
  const rate = card.rate == null || card.rate === '' ? NaN : Number(card.rate);
  const fallback = DEFAULT_STATUTORY_RULES[card.type] ?? DEFAULT_STATUTORY_RULES.SENIOR;
  return {
    ratePercent: Number.isFinite(rate) ? rate : fallback.ratePercent,
    vatExempt: typeof card.vat_exempt === 'boolean' ? card.vat_exempt : fallback.vatExempt,
  };
}

/** Each recorded line's card — the shared line → card rule (`assignStatutoryLines`), as the server applies it at sync. */
export function payloadStatutoryLines(
  payload: Pick<SalePayload, 'statutory_cards' | 'statutory_discount' | 'lines'>,
  flags: (skuId: number) => { scPwdEligible: boolean; soloParentEligible?: boolean },
): (PayloadStatutoryLine | null)[] {
  const { cards, explicit } = payloadStatutoryCards(payload);
  if (cards.length === 0) return payload.lines.map(() => null);
  const { types } = assignStatutoryLines(
    cards.map((c) => c.type),
    explicit,
    payload.lines.map((l) => {
      const f = flags(l.sku_id);
      return { statutoryType: l.statutory_type ?? null, model: { sc_pwd_eligible: f.scPwdEligible, solo_parent_eligible: f.soloParentEligible === true } };
    }),
  );
  return types.map((type) => {
    if (type === null) return null;
    const card = cards.find((c) => c.type === type)!;
    return { type, ...payloadCardRule(card) };
  });
}

/** Re-prices a recorded payload (receipt / reprint) with the same shared code. `flags` per sku_id from the catalog. */
export function computePayloadTotals(
  payload: SalePayload,
  flags: (skuId: number) => { isVatable: boolean; scPwdEligible: boolean; soloParentEligible?: boolean },
): SaleTotals {
  const statutoryLines = payloadStatutoryLines(payload, flags);
  const statutoryOn = payloadStatutoryCards(payload).cards.length > 0;
  const pct = (s: string | null | undefined) => (s == null || s === '' ? '' : s);
  return computeCartTotals(
    payload.lines.map((l, idx) => {
      const f = flags(l.sku_id);
      const percent = pct(l.item_discount_percent);
      const st = statutoryLines[idx] ?? null;
      return {
        quantity: l.quantity,
        unitPrice: Number(l.unit_price),
        isVatable: f.isVatable,
        isStatutory: st !== null,
        // A statutory line of a promo item where the cashier chose the promo: no rate off, the type's VAT treatment (as
        // the server prices it).
        ...(st !== null ? { statutoryDiscountRate: l.promo_vs_scpwd === 'PROMO' ? 0 : st.ratePercent / 100, statutoryVatExempt: st.vatExempt } : {}),
        itemDiscount: percent !== '' ? { value: percent, mode: 'percent' } : { value: l.item_discount_amount ?? '', mode: 'amount' },
      };
    }),
    pct(payload.transaction_discount_percent) !== ''
      ? { value: payload.transaction_discount_percent!, mode: 'percent' }
      : { value: payload.transaction_discount_amount ?? '', mode: 'amount' },
    statutoryOn,
    // The mode the sale was charged in (absent = before-VAT: recorded by an older app version).
    payload.prices_include_vat ?? false,
  );
}
