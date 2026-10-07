// Self-test of store promos applied OFFLINE on the till — pure code, no device or server:
//   * src/sale/promos.ts — bootstrap `promos` read defensively, the promo in force for a line (device clock: in force /
//     not yet / ended / end exclusive), two overlapping on a device (the server makes it impossible; the lower price
//     wins), rounding (shared @shared/promos/promo-math, integer centavos half-up), a promo that wouldn't lower the price,
//     re-checks while the cart is open, the Senior/PWD Promo-vs-SC/PWD choice (no default) and the payload fields;
//   * src/sale/totals.ts — the shared pricing with a PROMO choice (statutoryDiscountRate 0: VAT-exempt, no 20 %) and the
//     same figures re-computed from a recorded payload (receipt / reprint).
// GamotERP docs/plans/labels-promos-recommendations.md "As built — Part A promos" + "POS app work".
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/promo-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import type { PosBootstrap, PosPromo, SalePayload } from '@pos-api/contract';

import {
  chargedLine,
  linePromoAt,
  promoChoiceProblem,
  promoPayloadFields,
  promoRefreshNotice,
  promosCurrentAt,
  promosOf,
  refreshLinePromos,
  scPwdComparison,
  withPromoAt,
  type PromoLine,
} from '../src/sale/promos';
import { computeCartTotals, computePayloadTotals, NO_DISCOUNT } from '../src/sale/totals';

declare const process: { exitCode?: number };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// Manila 2026-10-10 08:00 → 2026-10-12 00:00 (ISO with offset, as the server sends them).
const P15: PosPromo = {
  id: 7,
  name: 'Payday 15%',
  discount_type: 'PERCENT_OFF',
  discount_value: '15.00',
  starts_at: '2026-10-10T08:00:00+08:00',
  ends_at: '2026-10-12T00:00:00+08:00',
  sku_ids: [101, 102],
};
const at = (iso: string) => new Date(iso);
const DURING = at('2026-10-11T12:00:00+08:00');

// ---- bootstrap ---------------------------------------------------------------------------------------------------
check('no bootstrap → none', promosOf(null).length === 0);
check('older server (no promos field) → none', promosOf({} as PosBootstrap).length === 0);
check('promos read', promosOf({ promos: [P15] } as unknown as PosBootstrap).length === 1);
check(
  'malformed entries skipped',
  promosOf({
    promos: [P15, null, { ...P15, id: 'x' }, { ...P15, discount_type: 'BOGO' }, { ...P15, discount_value: 'abc' }, { ...P15, starts_at: 'nope' }, { ...P15, sku_ids: 'all' }],
  } as unknown as PosBootstrap).length === 1,
);
check('promos not an array → none', promosOf({ promos: 'x' } as unknown as PosBootstrap).length === 0);

// ---- in force (device clock) --------------------------------------------------------------------------------------
check('in force → 100.00 at 15% = 85.00', linePromoAt([P15], 101, '100.00', DURING)?.priceText === '85.00', linePromoAt([P15], 101, '100.00', DURING));
check('not yet started → none', linePromoAt([P15], 101, '100.00', at('2026-10-10T07:59:59+08:00')) === null);
check('starts_at itself → in force', linePromoAt([P15], 101, '100.00', at('2026-10-10T08:00:00+08:00')) !== null);
check('ends_at is exclusive → ended', linePromoAt([P15], 101, '100.00', at('2026-10-12T00:00:00+08:00')) === null);
check('one ms before the end → still in force', linePromoAt([P15], 101, '100.00', at('2026-10-11T23:59:59.999+08:00')) !== null);
check('ended → none', linePromoAt([P15], 101, '100.00', at('2026-10-13T09:00:00+08:00')) === null);
check('another SKU → none', linePromoAt([P15], 999, '100.00', DURING) === null);
check('no promos → none', linePromoAt([], 101, '100.00', DURING) === null);
check('terms text', linePromoAt([P15], 101, '100.00', DURING)?.terms === '15% off');

// ---- overlapping (the server refuses it at publish; a device holding two anyway takes the lower price) ------------
const P20OFF: PosPromo = { ...P15, id: 8, name: '₱20 off', discount_type: 'AMOUNT_OFF', discount_value: '20.00' };
check('two in force → lower price (₱20 off beats 15% on 100)', linePromoAt([P15, P20OFF], 101, '100.00', DURING)?.id === 8);
check('two in force → lower price (15% beats ₱20 off on 200)', linePromoAt([P15, P20OFF], 101, '200.00', DURING)?.id === 7);
check('order of the list doesn’t matter', linePromoAt([P20OFF, P15], 101, '200.00', DURING)?.id === 7);

// ---- rounding (shared promo-math: integer centavos, half-up) ---------------------------------------------------------
const pct = (v: string): PosPromo => ({ ...P15, discount_value: v });
check('99.99 at 33.33% → 66.66', linePromoAt([pct('33.33')], 101, '99.99', DURING)?.priceText === '66.66', linePromoAt([pct('33.33')], 101, '99.99', DURING));
check('0.05 at 50% → 0.03 (half-up)', linePromoAt([pct('50')], 101, '0.05', DURING)?.priceText === '0.03');
check('10.01 at 15.5% → 8.46 (8.45845 half-up)', linePromoAt([pct('15.50')], 101, '10.01', DURING)?.priceText === '8.46');
check('price as number kept exact', linePromoAt([pct('15')], 101, '258.06', DURING)?.price === 219.35);
const FIX = (v: string): PosPromo => ({ ...P15, id: 9, discount_type: 'FIXED_PRICE', discount_value: v });
check('fixed promo price', linePromoAt([FIX('79.50')], 101, '100.00', DURING)?.priceText === '79.50');
check('fixed price above the regular → doesn’t apply', linePromoAt([FIX('120.00')], 101, '100.00', DURING) === null);
check('fixed price equal to the regular → doesn’t apply', linePromoAt([FIX('100.00')], 101, '100.00', DURING) === null);
const OFF = (v: string): PosPromo => ({ ...P15, id: 10, discount_type: 'AMOUNT_OFF', discount_value: v });
check('₱ off more than the price → 0.00', linePromoAt([OFF('150.00')], 101, '100.00', DURING)?.priceText === '0.00');
check('regular price 0 → no promo', linePromoAt([P15], 101, '0.00', DURING) === null);

// ---- cart lines: re-check while the cart is open ------------------------------------------------------------------
const line = (over: Partial<PromoLine> = {}): PromoLine => ({
  skuId: 101,
  name: 'Paracetamol 500 mg',
  quantity: 2,
  unitPriceText: '100.00',
  unitPrice: 100,
  scPwdEligible: true,
  promo: null,
  promoChoice: null,
  ...over,
});
const before = line();
const started = refreshLinePromos([before], [P15], DURING);
check('promo starts while the cart is open → applied', started.changed && started.lines[0]!.promo?.id === 7 && started.started[0] === 'Payday 15%');
check('notice says so', (promoRefreshNotice(started) ?? '').includes('Promo now applied: Payday 15%'));
const same = refreshLinePromos(started.lines, [P15], DURING);
check('nothing changed → same line objects, no notice', !same.changed && same.lines[0] === started.lines[0] && promoRefreshNotice(same) === null);
const chosen = { ...started.lines[0]!, promoChoice: 'PROMO' as const };
check('same promo still in force → choice kept', withPromoAt(chosen, [P15], DURING).promoChoice === 'PROMO');
const ended = refreshLinePromos([chosen], [P15], at('2026-10-12T00:00:01+08:00'));
check('promo ends while the cart is open → regular price, choice cleared', ended.changed && ended.lines[0]!.promo === null && ended.lines[0]!.promoChoice === null);
check('notice: ended', (promoRefreshNotice(ended) ?? '').includes('Promo ended: Payday 15%'));
const cancelled = refreshLinePromos([chosen], [], DURING);
check('cancelled / ended early (gone from bootstrap) → regular price', cancelled.changed && cancelled.lines[0]!.promo === null);
const swapped = withPromoAt(chosen, [P20OFF], DURING);
check('another promo now → its price, choice cleared', swapped.promo?.id === 8 && swapped.promoChoice === null);
check('promosCurrentAt: current', promosCurrentAt(started.lines, [P15], DURING));
check('promosCurrentAt: stale after the end', !promosCurrentAt(started.lines, [P15], at('2026-10-12T00:00:00+08:00')));
check('promosCurrentAt: no-promo line, none in force', promosCurrentAt([before], [P15], at('2026-10-01T00:00:00+08:00')));

// ---- what's charged + Senior/PWD choice -----------------------------------------------------------------------------
const promoLine = started.lines[0]!; // 2 × 100.00, promo 85.00
check('no promo → regular', chargedLine(before, false).unitPriceText === '100.00' && !chargedLine(before, false).promoApplied);
check('promo, not a statutory line → promo price', chargedLine(promoLine, false).unitPriceText === '85.00' && chargedLine(promoLine, false).statutoryDiscountRate === undefined);
check('statutory, not chosen → provisional regular (blocked)', chargedLine(promoLine, true).unitPriceText === '100.00');
check('statutory, PROMO → promo price, rate 0', chargedLine({ ...promoLine, promoChoice: 'PROMO' }, true).unitPriceText === '85.00' && chargedLine({ ...promoLine, promoChoice: 'PROMO' }, true).statutoryDiscountRate === 0);
check('statutory, SCPWD → regular, default 20%', chargedLine({ ...promoLine, promoChoice: 'SCPWD' }, true).unitPriceText === '100.00' && chargedLine({ ...promoLine, promoChoice: 'SCPWD' }, true).statutoryDiscountRate === undefined);
const cmp = scPwdComparison(promoLine)!;
check('comparison: promo 170.00 vs SC/PWD 160.00 → SC/PWD better', cmp.promo_total === 170 && cmp.scpwd_total === 160 && cmp.better === 'SCPWD', cmp);
const deep = withPromoAt(line(), [pct('30')], DURING);
check('comparison: 30% promo beats the 20%', scPwdComparison(deep)!.better === 'PROMO');
check('comparison: equal at 20%', scPwdComparison(withPromoAt(line(), [pct('20')], DURING))!.better === 'EQUAL');
check('no promo → no comparison', scPwdComparison(before) === null);
const isStat = () => true;
check('choice required, no default → blocked', (promoChoiceProblem([promoLine], isStat) ?? '').includes('Choose Promo or Senior/PWD 20% for Paracetamol 500 mg'));
check('chosen → not blocked', promoChoiceProblem([{ ...promoLine, promoChoice: 'SCPWD' }], isStat) === null);
check('not a Senior/PWD sale → no choice needed', promoChoiceProblem([promoLine], () => false) === null);
check('two open → counted', (promoChoiceProblem([promoLine, { ...promoLine, skuId: 102, name: 'B' }], isStat) ?? '').includes('2 items'));

// ---- payload fields ------------------------------------------------------------------------------------------------
check('no promo → no fields (older servers unaffected)', Object.keys(promoPayloadFields(before, false)).length === 0);
const f1 = promoPayloadFields(promoLine, false);
check('promo, regular sale → promo_id + regular price, choice null', f1.promo_id === 7 && f1.regular_unit_price === '100.00' && f1.promo_vs_scpwd === null, f1);
const f2 = promoPayloadFields({ ...promoLine, promoChoice: 'SCPWD' }, true);
check('SC/PWD chose the 20% → still sends the promo it passed over', f2.promo_id === 7 && f2.regular_unit_price === '100.00' && f2.promo_vs_scpwd === 'SCPWD', f2);

// ---- shared pricing with the choice -----------------------------------------------------------------------------------
// The server's verified figures (promo-selftest): 258.06 at 15 % → 219.35; 2 × VAT → 491.34 VAT-ful.
const sale = (rate: number | undefined, unit: number, statutory: boolean) =>
  computeCartTotals(
    [{ quantity: 2, unitPrice: unit, isVatable: true, isStatutory: statutory, ...(rate !== undefined ? { statutoryDiscountRate: rate } : {}), itemDiscount: NO_DISCOUNT }],
    NO_DISCOUNT,
    statutory,
  );
const regularPromo = sale(undefined, 219.35, false);
check('promo price + 12% VAT: 2 × 219.35 = 438.70 + 52.64 = 491.34', regularPromo.grandTotal === 491.34 && regularPromo.totalVat === 52.64, regularPromo);
const promoChoice = sale(0, 85, true);
check('PROMO choice: 170.00 VAT-exempt, no 20%', promoChoice.grandTotal === 170 && promoChoice.totalStatutoryDiscount === 0 && promoChoice.totalVat === 0 && promoChoice.vatExemptSales === 170, promoChoice);
const scChoice = sale(undefined, 100, true);
check('SCPWD choice: 200.00 less 20% = 160.00 VAT-exempt', scChoice.grandTotal === 160 && scChoice.totalStatutoryDiscount === 40 && scChoice.totalVat === 0, scChoice);
check('the cart’s choice amounts = compareScPwd’s', promoChoice.grandTotal === cmp.promo_total && scChoice.grandTotal === cmp.scpwd_total);

// A recorded payload re-priced for the receipt / reprint gives the same figures (statutoryDiscountRate 0 on PROMO).
const payload = (choice: 'PROMO' | 'SCPWD', unit: string) =>
  ({
    statutory_discount: { type: 'SENIOR' },
    lines: [{ sku_id: 101, quantity: 2, unit_price: unit, promo_id: 7, regular_unit_price: '100.00', promo_vs_scpwd: choice }],
    transaction_discount_amount: '0.00',
    transaction_discount_percent: null,
  }) as unknown as SalePayload;
const flags = () => ({ isVatable: true, scPwdEligible: true });
check('reprint, PROMO choice → 170.00, no 20%', computePayloadTotals(payload('PROMO', '85.00'), flags).grandTotal === 170 && computePayloadTotals(payload('PROMO', '85.00'), flags).totalStatutoryDiscount === 0);
check('reprint, SCPWD choice → 160.00', computePayloadTotals(payload('SCPWD', '100.00'), flags).grandTotal === 160);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
