// "Bill to company" (BIR Phase 1 — GamotERP docs/plans/bir-phase1-invoice-contract.md §1, §5): an optional client company
// buyer with the withholding it deducts. The MATHS is only `@shared/withholding` (the server recomputes every synced sale
// with the same code and flags a difference — never re-implement it here); this file wires it to the cart's totals and
// builds the sale op's fields. Online only (the company comes from GET /pos/client-companies); no company = nothing here
// changes: the AMOUNT DUE is the grand total and the payload carries none of the new fields.
import type { PosClientCompany, SalePayload } from '@pos-api/contract';
import {
  computeWithholding,

  sameWithholdingRates,
  withholdingRatesValid,
  withholdingVatableBase,
  WITHHOLDING_MAX_EWT_RATE,
  WITHHOLDING_MAX_VAT_RATE,
  type WithholdingAmounts,
  type WithholdingRates,
} from '@shared/withholding';
import type { SaleTotals } from './totals';
import { money } from './money';

/** The invoice total from which a company buyer's TIN is required (BIR: ₱1,000 or more) — as the server. */
export const BUYER_TIN_REQUIRED_FROM = 1000;

/** The cashier's own rates for this sale (typed percents) + the reason they must give. */
export interface WithholdingOverrideDraft {
  ewtRate: string;
  vatRate: string;
  reason: string;
}

/** The sale's buyer company, as picked at the till (lives in the cart, cleared with it). */
export interface BillToDraft {
  company: PosClientCompany;
  /** The TIN typed when the company has none on record. */
  tin: string;
  /** Null = the company's own rates. */
  override: WithholdingOverrideDraft | null;
}

/** The rates the company's setting means (the server's effective rates, sent as percent strings). */
export function companyRates(company: PosClientCompany): WithholdingRates {
  return { ewtRate: Number(company.ewt_rate) || 0, vatRate: Number(company.vat_rate) || 0 };
}

/** Typed percents → rates (NaN when blank / junk, which `withholdingRatesValid` refuses). */
export function overrideRates(o: WithholdingOverrideDraft): WithholdingRates {
  const n = (s: string) => (s.trim() === '' ? Number.NaN : Number(s.trim()));
  return { ewtRate: n(o.ewtRate), vatRate: n(o.vatRate) };
}

/** The rates in force for this draft (override when set and readable, else the company's). */
export function ratesOf(bill: BillToDraft): WithholdingRates {
  if (!bill.override) return companyRates(bill.company);
  const r = overrideRates(bill.override);
  return withholdingRatesValid(r) ? r : companyRates(bill.company);
}

export interface BillingFigures {
  rates: WithholdingRates;
  amounts: WithholdingAmounts;
}

/**
 * The withholding on the cart's totals: EWT on (grand total − VAT), the VAT part on VAT Sales (the shared
 * `withholdingVatableBase` over the priced lines; a non-VAT seller has none). `sellerVatRegistered` = the bootstrap's
 * `receipt.vat_registered` (= `pricesIncludeVat`).
 */
export function withholdingFigures(totals: SaleTotals, bill: BillToDraft | null, sellerVatRegistered: boolean): BillingFigures | null {
  if (!bill) return null;
  const rates = ratesOf(bill);
  const vatableBase = withholdingVatableBase(
    totals.lines.map((l) => ({ taxableBase: l.taxableBase, isVatable: l.isVatable, isStatutory: l.isStatutory })),
    { sellerVatRegistered },
  );
  const amounts = computeWithholding({ grandTotal: totals.grandTotal, totalVat: totals.totalVat, vatableBase }, rates);
  return { rates, amounts };
}

/** What the payments must add up to: the grand total less the withholding (grand total when there is none). */
export function amountDueOf(totals: SaleTotals, figures: BillingFigures | null): number {
  return figures ? figures.amounts.amountDue : totals.grandTotal;
}

/** The buyer's TIN as it will print and go out: the company's, else the typed one (null = none). */
export function buyerTinOf(bill: BillToDraft): string | null {
  const t = (bill.company.tin ?? '').trim() || bill.tin.trim();
  return t === '' ? null : t;
}

/** Why the company buyer can't be charged yet (null = ready / no company). */
export function billingProblem(bill: BillToDraft | null, totals: SaleTotals): string | null {
  if (!bill) return null;
  if (totals.grandTotal >= BUYER_TIN_REQUIRED_FROM && buyerTinOf(bill) === null) {
    return 'Enter the company’s TIN — it is required on an invoice of ₱1,000 or more.';
  }
  if (bill.override) {
    const r = overrideRates(bill.override);
    if (!withholdingRatesValid(r)) {
      return `Withholding rates: EWT 0–${WITHHOLDING_MAX_EWT_RATE}% and VAT 0–${WITHHOLDING_MAX_VAT_RATE}%, at most 2 decimals.`;
    }
    if (!sameWithholdingRates(r, companyRates(bill.company)) && bill.override.reason.trim() === '') {
      return 'Enter the reason for changing the withholding rates.';
    }
  }
  return null;
}

const percent = (n: number) => n.toFixed(2);

/**
 * The sale op's new fields (all optional on the contract; absent = old behaviour). Only with a company picked; money /
 * percents as strings. `override_reason` is sent only when the rates differ from the company's setting.
 */
export function billingPayload(bill: BillToDraft | null, figures: BillingFigures | null): Pick<SalePayload, 'client_company_id' | 'buyer_tin' | 'withholding'> | Record<string, never> {
  if (!bill || !figures) return {};
  const differs = !sameWithholdingRates(figures.rates, companyRates(bill.company));
  const typed = (bill.company.tin ?? '').trim() === '' ? bill.tin.trim() : '';
  return {
    client_company_id: bill.company.id,
    // Only the TIN typed at the sale (the company's own is on the server's record).
    ...(typed !== '' ? { buyer_tin: typed } : {}),
    withholding: {
      ewt_rate: percent(figures.rates.ewtRate),
      vat_rate: percent(figures.rates.vatRate),
      ewt_amount: money(figures.amounts.ewtAmount),
      vat_amount: money(figures.amounts.vatAmount),
      override_reason: differs ? bill.override?.reason.trim() || null : null,
    },
  };
}


