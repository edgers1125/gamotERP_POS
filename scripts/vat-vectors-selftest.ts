// Self-test of VAT-inclusive pricing on the till — the backend's shared test vectors
// (GamotERP apps/pharma/backend/src/lib/vat-inclusive.vectors.json; docs/claude/pos-android.md "POS APK changes needed for
// VAT-inclusive prices") through the app's own code: @shared/vat-inclusive, src/sale/totals.ts computeCartTotals (the
// cart's wiring of the pricing mode) and pricesIncludeVatOf (the mode from the bootstrap).
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/vat-vectors-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import { allocateReceiptVat, vatInclusiveUnitPrice } from '@shared/vat-inclusive';
import { computeCartTotals, NO_DISCOUNT, pricesIncludeVatOf } from '../src/sale/totals';
import vectors from '@shared/vat-inclusive.vectors.json';

type Sale = {
  name: string;
  pricesIncludeVat: boolean;
  lines: { quantity: number; unitPrice: number; isVatable: boolean; itemDiscountAmount?: number; isStatutory?: boolean }[];
  transactionDiscount: number;
  subtotal: number;
  totalVat: number;
  grandTotal: number;
  totalStatutoryDiscount?: number;
  vatExemptSales?: number;
  refund?: boolean;
};
const v = vectors as unknown as {
  unitPrices: [number, number][];
  receipts: { lineTotalsCents: number[]; totalVatCents: number; lineVatCents: number[] }[];
  sales: Sale[];
};

let failed = 0;
let run = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  run++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

for (const [p, want] of v.unitPrices) eq(`vatInclusiveUnitPrice(${p})`, vatInclusiveUnitPrice(p), want);
for (const r of v.receipts) {
  eq(`allocateReceiptVat(${r.lineTotalsCents})`, allocateReceiptVat(r.lineTotalsCents), { totalVatCents: r.totalVatCents, lineVatCents: r.lineVatCents });
}
for (const s of v.sales) {
  const statutoryOn = s.lines.some((l) => l.isStatutory);
  const t = computeCartTotals(
    s.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      isVatable: l.isVatable,
      isStatutory: l.isStatutory ?? false,
      itemDiscount: l.itemDiscountAmount ? { value: String(l.itemDiscountAmount), mode: 'amount' } : NO_DISCOUNT,
    })),
    s.transactionDiscount > 0 ? { value: String(s.transactionDiscount), mode: 'amount' } : NO_DISCOUNT,
    statutoryOn,
    s.pricesIncludeVat,
  );
  // refund: the expected figures are the sale's negated (refunds are online-only — the device prices the sale).
  const sign = s.refund ? -1 : 1;
  const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
  eq(
    s.name,
    [t.subtotal, t.totalVat, t.grandTotal, t.totalStatutoryDiscount, t.vatExemptSales].map((n) => r2(sign * n)),
    [s.subtotal, s.totalVat, s.grandTotal, s.totalStatutoryDiscount ?? 0, s.vatExemptSales ?? 0].map(r2),
  );
}

// The mode comes only from the bootstrap's receipt.vat_registered (field absent = registered; no receipt = before-VAT).
eq('mode: vat_registered true', pricesIncludeVatOf({ receipt: { vat_registered: true } }), true);
eq('mode: vat_registered false', pricesIncludeVatOf({ receipt: { vat_registered: false } }), false);
eq('mode: field absent', pricesIncludeVatOf({ receipt: {} }), true);
eq('mode: no bootstrap', pricesIncludeVatOf(null), false);

console.log(failed === 0 ? `vat vectors: all ${run} passed` : `vat vectors: ${failed} of ${run} FAILED`);
process.exit(failed === 0 ? 0 : 1);
