// Self-test of "Bill to company" withholding on the till — the backend's shared test vectors
// (GamotERP apps/pharma/backend/src/lib/withholding.vectors.json; BIR Phase 1) through the app's own code:
// @shared/withholding (the maths), src/sale/totals.ts computeCartTotals (the cart's pricing) and src/sale/billing.ts
// (withholdingFigures / amountDueOf / billingPayload / billingProblem — the till's wiring). Same vectors as the server's
// prisma/withholding-vectors-selftest.ts.
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/withholding-vectors-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import { computeWithholding, effectiveWithholdingRates, withholdingVatableBase, type WithholdingType } from '@shared/withholding';
import vectors from '@shared/withholding.vectors.json';
import type { PosClientCompany } from '@pos-api/contract';
import { computeCartTotals, NO_DISCOUNT, type SaleTotals } from '../src/sale/totals';
import { amountDueOf, billingPayload, billingProblem, withholdingFigures, type BillToDraft } from '../src/sale/billing';

// BIR Phase 2: a statutory line's rate (fraction) + VAT treatment (a NAAC line's base is VAT Sales).
type Line = { quantity: number; unitPrice: number; isVatable: boolean; itemDiscountAmount?: number; isStatutory?: boolean; statutoryRate?: number; statutoryVatExempt?: boolean };
type Vector = {
  name: string;
  type: WithholdingType;
  custom?: { ewt: number; vat: number };
  sellerVatRegistered?: boolean;
  refund?: boolean;
  sale?: { pricesIncludeVat: boolean; transactionDiscount: number; lines: Line[] };
  figures?: { grandTotal: number; totalVat: number; vatableBase: number };
  expected: { grandTotal?: number; totalVat?: number; vatableBase?: number; ewtAmount: number; vatAmount: number; amount: number; amountDue: number };
};
const list = (vectors as unknown as { vectors: Vector[] }).vectors;

let failed = 0;
let run = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  run++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const neg = (n: number) => -n + 0;
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;

function company(type: WithholdingType, custom?: { ewt: number; vat: number }): PosClientCompany {
  const r = effectiveWithholdingRates(type, custom?.ewt, custom?.vat);
  return { id: 7, name: 'Acme Corp', address: 'Manila', tin: '123-456-789-000', withholding_type: type, withholding_label: type, ewt_rate: r.ewtRate.toFixed(2), vat_rate: r.vatRate.toFixed(2) };
}

for (const v of list) {
  const bill: BillToDraft = { company: company(v.type, v.custom), tin: '', override: null };
  // Whole-sale vectors: the till's own pricing (a refund isn't priced on the device — it is checked on the figures below).
  if (v.sale && !v.refund) {
    const t = computeCartTotals(
      v.sale.lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        isVatable: l.isVatable,
        isStatutory: l.isStatutory ?? false,
        ...(l.statutoryRate !== undefined ? { statutoryDiscountRate: l.statutoryRate } : {}),
        ...(l.statutoryVatExempt !== undefined ? { statutoryVatExempt: l.statutoryVatExempt } : {}),
        itemDiscount: l.itemDiscountAmount ? { value: String(l.itemDiscountAmount), mode: 'amount' } : NO_DISCOUNT,
      })),
      v.sale.transactionDiscount > 0 ? { value: String(v.sale.transactionDiscount), mode: 'amount' } : NO_DISCOUNT,
      v.sale.lines.some((l) => l.isStatutory),
      v.sale.pricesIncludeVat,
    );
    const f = withholdingFigures(t, bill, v.sellerVatRegistered !== false);
    eq(`${v.name} - till figures`, [t.grandTotal, t.totalVat, withholdingVatableBase(t.lines, { sellerVatRegistered: v.sellerVatRegistered })], [v.expected.grandTotal, v.expected.totalVat, v.expected.vatableBase]);
    eq(`${v.name} - till amounts`, f && { ewtAmount: f.amounts.ewtAmount, vatAmount: f.amounts.vatAmount, amount: f.amounts.amount, amountDue: f.amounts.amountDue }, {
      ewtAmount: v.expected.ewtAmount,
      vatAmount: v.expected.vatAmount,
      amount: v.expected.amount,
      amountDue: v.expected.amountDue,
    });
    eq(`${v.name} - amount due`, amountDueOf(t, f), v.expected.amountDue);
    eq(`${v.name} - payload`, billingPayload(bill, f), {
      client_company_id: 7,
      withholding: { ewt_rate: f!.rates.ewtRate.toFixed(2), vat_rate: f!.rates.vatRate.toFixed(2), ewt_amount: v.expected.ewtAmount.toFixed(2), vat_amount: v.expected.vatAmount.toFixed(2), override_reason: null },
    });
    continue;
  }
  // `figures` / refund vectors: the shared maths directly (the till never prices a refund).
  // (a `sale` vector's expected figures are already the refund's negated ones.)
  let figures = v.figures ?? { grandTotal: v.expected.grandTotal!, totalVat: v.expected.totalVat!, vatableBase: v.expected.vatableBase! };
  if (v.refund && v.figures) figures = { grandTotal: neg(figures.grandTotal), totalVat: neg(figures.totalVat), vatableBase: neg(figures.vatableBase) };
  const got = computeWithholding(figures, effectiveWithholdingRates(v.type, v.custom?.ewt, v.custom?.vat));
  eq(v.name, got, { ewtAmount: v.expected.ewtAmount, vatAmount: v.expected.vatAmount, amount: v.expected.amount, amountDue: v.expected.amountDue });
}

// ---- the till's rules around it -------------------------------------------------------------------------------------
const totalsOf = (grandTotal: number, totalVat = 0, vatable = 0): SaleTotals =>
  ({ grandTotal, totalVat, lines: vatable > 0 ? [{ taxableBase: vatable, isVatable: true, isStatutory: false }] : [] }) as unknown as SaleTotals;
const gov = company('GOVERNMENT');
const plain = (c: PosClientCompany, tin = ''): BillToDraft => ({ company: c, tin, override: null });
// No company: nothing changes.
eq('no company: amount due = total', amountDueOf(totalsOf(500), withholdingFigures(totalsOf(500), null, true)), 500);
eq('no company: no payload fields', billingPayload(null, null), {});
eq('no company: no problem', billingProblem(null, totalsOf(5000)), null);
// TIN: required from 1,000 only when neither the company nor the cashier has one.
const noTin = { ...gov, tin: null };
eq('TIN required at 1000', billingProblem(plain(noTin), totalsOf(1000)) !== null, true);
eq('TIN not required at 999.99', billingProblem(plain(noTin), totalsOf(999.99)), null);
eq('typed TIN satisfies it', billingProblem(plain(noTin, '111-222-333-000'), totalsOf(5000)), null);
eq('company TIN satisfies it', billingProblem(plain(gov), totalsOf(5000)), null);
const t500 = totalsOf(500);
eq('typed TIN goes out as buyer_tin', (billingPayload(plain(noTin, ' 111-222 '), withholdingFigures(t500, plain(noTin), true)) as { buyer_tin?: string }).buyer_tin, '111-222');
eq('company TIN is not re-sent', 'buyer_tin' in billingPayload(plain(gov), withholdingFigures(t500, plain(gov), true)), false);
// Override: needs valid rates and, when they differ from the company's, a reason; the reason goes out.
const ov = (ewtRate: string, vatRate: string, reason: string): BillToDraft => ({ company: gov, tin: '', override: { ewtRate, vatRate, reason } });
eq('override: differing rates need a reason', billingProblem(ov('2', '0', ''), t500) !== null, true);
eq('override: reason given', billingProblem(ov('2', '0', 'Services'), t500), null);
eq('override: same rates as the company need none', billingProblem(ov('1.00', '5', ''), t500), null);
eq('override: EWT above 15 refused', billingProblem(ov('16', '0', 'x'), t500) !== null, true);
eq('override: junk refused', billingProblem(ov('', '0', 'x'), t500) !== null, true);
{
  const t = totalsOf(1120, 120, 1000);
  const b = ov('2', '0', ' Services ');
  const f = withholdingFigures(t, b, true)!;
  eq('override: amounts', [f.amounts.ewtAmount, f.amounts.vatAmount, f.amounts.amountDue].map(r2), [20, 0, 1100]);
  eq('override: payload', billingPayload(b, f), {
    client_company_id: 7,
    withholding: { ewt_rate: '2.00', vat_rate: '0.00', ewt_amount: '20.00', vat_amount: '0.00', override_reason: 'Services' },
  });
}

console.log(failed === 0 ? `withholding vectors: all ${run} passed` : `withholding vectors: ${failed} of ${run} FAILED`);
process.exit(failed === 0 ? 0 : 1);
