// Self-test of the statutory discounts on the till (BIR Phase 2 + 2b — GamotERP
// docs/plans/bir-statutory-discounts-contract.md) — pure code, no device or server:
//   * src/sale/statutory.ts — the bootstrap rules read defensively (older server → Senior / PWD only), the card checks
//     (expiry per type, Medal of Valor off, Solo Parent children ≤ 6 on the sale day, the Rx attestation), the payload;
//   * src/sale/cards.ts — which line gets which card (one card: every eligible line; several: each line's pick, default
//     the first card it's eligible for, 'NONE'), each type's rate + VAT treatment through the shared pricing code (the
//     contract's NAAC example), the discount rows, the checks before charging, statutory_discount vs statutory_cards;
//   * src/sale/totals.ts — the same figures re-computed from the recorded payload (receipt / reprint).
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/statutory-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import type { PosBootstrap, SalePayload } from '@pos-api/contract';
import type { CartLine, CartState } from '../src/sale/cart';
import {
  cartTotals,
  lineCardOptions,
  lineCardType,
  promoCardComparison,
  statutoryCardsProblem,
  statutoryDiscountRows,
  statutoryFields,
} from '../src/sale/cards';
import {
  clientStatutoryBlock,
  EMPTY_STATUTORY,
  LEGACY_STATUTORY_CONFIG,
  offeredTypes,
  statutoryConfigOf,
  statutoryProblem,
  type StatutoryConfig,
  type StatutoryDraft,
} from '../src/sale/statutory';
import { computePayloadTotals, NO_DISCOUNT, payloadLineCardTypes } from '../src/sale/totals';

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
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ---- the company's rules from the bootstrap -------------------------------------------------------------------------
const bootstrapRules = (types: unknown, oneTypePerSale: unknown = true) =>
  ({ statutory_discounts: { types, one_type_per_sale: oneTypePerSale } }) as unknown as Pick<PosBootstrap, 'statutory_discounts'>;
const SERVER_TYPES = [
  { type: 'SENIOR', enabled: true, rate: '20.00', vat_exempt: true, fixed_by_law: true, eligible_flag: 'sc_pwd_eligible' },
  { type: 'PWD', enabled: true, rate: '20.00', vat_exempt: true, fixed_by_law: true, eligible_flag: 'sc_pwd_eligible' },
  { type: 'NAAC', enabled: true, rate: '20.00', vat_exempt: false, fixed_by_law: false, eligible_flag: 'sc_pwd_eligible' },
  { type: 'SOLO_PARENT', enabled: true, rate: '10.00', vat_exempt: true, fixed_by_law: false, eligible_flag: 'solo_parent_eligible' },
  { type: 'MEDAL_OF_VALOR', enabled: false, rate: '20.00', vat_exempt: false, fixed_by_law: false, eligible_flag: 'sc_pwd_eligible' },
];
const legacy = statutoryConfigOf({} as Pick<PosBootstrap, 'statutory_discounts'>);
eq('older server → Senior / PWD only', offeredTypes(legacy), ['SENIOR', 'PWD']);
check('older server → not known (no new fields sent)', legacy.known === false && legacy.oneTypePerSale);
const cfg = statutoryConfigOf(bootstrapRules(SERVER_TYPES));
eq('server rules → offered types (MoV off)', offeredTypes(cfg), ['SENIOR', 'PWD', 'NAAC', 'SOLO_PARENT']);
eq('server rules → Solo Parent 10 %, exempt', cfg.rules.SOLO_PARENT, { enabled: true, ratePercent: 10, vatExempt: true });
check('server rules → known, one type per sale', cfg.known && cfg.oneTypePerSale);
const tampered = statutoryConfigOf(
  bootstrapRules([
    { type: 'SENIOR', enabled: false, rate: '5.00', vat_exempt: false },
    { type: 'NAAC', enabled: true, rate: 'abc', vat_exempt: false },
    { type: 'SOLO_PARENT', enabled: true, rate: '150', vat_exempt: true },
    { type: 'MEDAL_OF_VALOR', enabled: true, rate: '15.5', vat_exempt: true },
    'junk',
  ]),
);
eq('Senior fixed by law whatever is sent', tampered.rules.SENIOR, { enabled: true, ratePercent: 20, vatExempt: true });
eq('unreadable NAAC rate → default', tampered.rules.NAAC, { enabled: true, ratePercent: 20, vatExempt: false });
eq('rate > 100 → default', tampered.rules.SOLO_PARENT.ratePercent, 10);
eq('MoV turned on at 15.5 %, exempt', tampered.rules.MEDAL_OF_VALOR, { enabled: true, ratePercent: 15.5, vatExempt: true });
const multiCfg: StatutoryConfig = statutoryConfigOf(bootstrapRules(SERVER_TYPES, false));
check('one_type_per_sale false → several cards allowed', !multiCfg.oneTypePerSale);

// ---- card checks ------------------------------------------------------------------------------------------------------
const TODAY = '2026-10-27';
const card = (patch: Partial<StatutoryDraft>): StatutoryDraft => ({ ...EMPTY_STATUTORY, idNumber: 'ID-1', firstName: 'Ana', lastName: 'Cruz', ...patch });
const ctx = { config: cfg, saleDay: TODAY };
eq('Senior: ready', statutoryProblem(card({ type: 'SENIOR' }), ctx), null);
check('PWD: expiry required', (statutoryProblem(card({ type: 'PWD' }), ctx) ?? '').includes('expiry date'));
check('Solo Parent: expiry required', (statutoryProblem(card({ type: 'SOLO_PARENT' }), ctx) ?? '').includes('expiry date'));
eq('NAAC: expiry optional', statutoryProblem(card({ type: 'NAAC' }), ctx), null);
check('NAAC: an expired ID refused', (statutoryProblem(card({ type: 'NAAC', expiryDate: '2020-01-01' }), ctx) ?? '').includes('expired'));
check('MoV off → refused', (statutoryProblem(card({ type: 'MEDAL_OF_VALOR' }), ctx) ?? '').includes('turned off'));
check('legacy server → NAAC not available', (statutoryProblem(card({ type: 'NAAC' }), { config: LEGACY_STATUTORY_CONFIG }) ?? '').includes('isn’t available'));
const sp = (patch: Partial<StatutoryDraft>) => card({ type: 'SOLO_PARENT', expiryDate: '2030-01-01', ...patch });
check('Solo Parent: no child → refused', (statutoryProblem(sp({}), ctx) ?? '').includes('Add the child'));
eq('Solo Parent: child aged 6 → fine', statutoryProblem(sp({ children: [{ name: 'Bea', birthDate: '2020-10-28' }] }), ctx), null);
check('Solo Parent: child turned 7 today → refused', (statutoryProblem(sp({ children: [{ name: 'Bea', birthDate: '2019-10-27' }] }), ctx) ?? '').includes('over 6'));
check('Solo Parent: child born after the sale day → refused', (statutoryProblem(sp({ children: [{ name: 'Bea', birthDate: '2026-10-28' }] }), ctx) ?? '').includes('after the sale day'));
check('Solo Parent: bad birth date → refused', (statutoryProblem(sp({ children: [{ name: 'Bea', birthDate: '2020-13-01' }] }), ctx) ?? '').includes('birth date'));
const kid = [{ name: 'Bea', birthDate: '2022-01-01' }];
check('Solo Parent Rx line: attestation required', (statutoryProblem(sp({ children: kid }), { ...ctx, rxLine: true }) ?? '').includes('child’s name'));
eq('Solo Parent Rx line: attested → fine', statutoryProblem(sp({ children: kid, rxInChildName: true }), { ...ctx, rxLine: true }), null);
const client = (patch: Record<string, unknown>) =>
  ({ id: 1, first_name: 'Ana', middle_name: null, last_name: 'Cruz', phone_number: null, statutory_id_number: 'X', statutory_id_issuer: null, id_expiry_date: null, date_of_birth: null, sex: null, has_address: false, ...patch }) as never;
eq('client card: Senior applies', clientStatutoryBlock(client({ statutory_type: 'SENIOR' }), cfg), null);
check('client card: Solo Parent needs the child (not auto-applied)', clientStatutoryBlock(client({ statutory_type: 'SOLO_PARENT', id_expiry_date: '2030-01-01' }), cfg) !== null);
eq('client card: Solo Parent in the form → usable', clientStatutoryBlock(client({ statutory_type: 'SOLO_PARENT', id_expiry_date: '2030-01-01' }), cfg, true), null);
check('client card: NAAC on an older server → blocked', clientStatutoryBlock(client({ statutory_type: 'NAAC' }), LEGACY_STATUTORY_CONFIG) !== null);

// ---- the cart: line → card, pricing ----------------------------------------------------------------------------------
const line = (skuId: number, patch: Partial<CartLine> = {}): CartLine => ({
  skuId,
  skuCode: `SKU${skuId}`,
  name: `Item ${skuId}`,
  packQuantity: 1,
  unitPriceText: '10.71',
  unitPrice: 10.71,
  isVatable: true,
  scPwdEligible: true,
  soloParentEligible: false,
  modelId: skuId,
  modelName: `Item ${skuId}`,
  rxRequired: false,
  dangerousDrug: false,
  quantity: 10,
  discount: NO_DISCOUNT,
  promo: null,
  promoChoice: null,
  ...patch,
});
type S = Pick<CartState, 'lines' | 'txDiscount' | 'statutory' | 'extraCards' | 'statutoryConfig' | 'pricesIncludeVat'>;
const state = (patch: Partial<S>): S => ({ lines: [], txDiscount: NO_DISCOUNT, statutory: null, extraCards: [], statutoryConfig: cfg, pricesIncludeVat: true, ...patch });

// The contract's example: 10 × 10.71 VAT-inclusive NAAC → 120.00 − 24.00 = 96.00, VAT 10.29.
const naac = state({ lines: [line(1)], statutory: card({ type: 'NAAC' }) });
const tn = cartTotals(naac);
eq('NAAC VAT-inclusive: subtotal / discount / VAT / total', [tn.subtotal, tn.totalStatutoryDiscount, tn.totalVat, tn.grandTotal, tn.vatExemptSales], [120, 24, 10.29, 96, 0]);
eq('NAAC discount row', statutoryDiscountRows(naac, tn), [{ type: 'NAAC', label: 'NAAC 20%', amount: 24 }]);
// Solo Parent: only solo_parent_eligible lines, 10 %, VAT-exempt.
const spState = state({ lines: [line(1), line(2, { soloParentEligible: true })], statutory: sp({ children: kid }) });
eq('Solo Parent: only the SP-eligible line', spState.lines.map((l) => lineCardType(spState, l)), [null, 'SOLO_PARENT']);
const ts = cartTotals(spState);
eq('Solo Parent 10 % VAT-exempt (120.00 shown → 107.14 base − 10.71)', [ts.totalStatutoryDiscount, ts.vatExemptSales, ts.grandTotal], [10.71, 96.43, 216.43]);
eq('Solo Parent row label', statutoryDiscountRows(spState, ts).map((r) => r.label), ['Solo Parent 10%']);

// Several cards (Phase 2b).
const two = state({
  statutoryConfig: multiCfg,
  lines: [line(1), line(2, { soloParentEligible: true }), line(3, { soloParentEligible: true, cardPick: 'SENIOR' }), line(4, { cardPick: 'NONE' }), line(5, { scPwdEligible: false })],
  statutory: card({ type: 'SENIOR' }),
  extraCards: [sp({ children: kid, firstName: 'Lia' })],
});
eq('several cards: default = first eligible card, picks, NONE, ineligible', two.lines.map((l) => lineCardType(two, l)), ['SENIOR', 'SENIOR', 'SENIOR', null, null]);
const twoSp = { ...two, lines: two.lines.map((l) => (l.skuId === 2 ? { ...l, cardPick: 'SOLO_PARENT' as const } : l)) };
eq('several cards: a line picks the Solo Parent card', twoSp.lines.map((l) => lineCardType(twoSp, l)), ['SENIOR', 'SOLO_PARENT', 'SENIOR', null, null]);
eq('several cards: line options', lineCardOptions(twoSp, twoSp.lines[1]!)?.map((o) => `${o.value}${o.selected ? '*' : ''}`), ['SENIOR', 'SOLO_PARENT*', 'NONE']);
eq('one card: no line picker', lineCardOptions(naac, naac.lines[0]!), undefined);
eq('several cards: ready', statutoryCardsProblem(twoSp, TODAY), null);
check('several cards: a card no line uses → refused', (statutoryCardsProblem(two, TODAY) ?? '').includes('No item gets the Solo Parent'));
check('several cards while the setting is ON → refused', (statutoryCardsProblem({ ...twoSp, statutoryConfig: cfg }, TODAY) ?? '').includes('Only one statutory discount'));
const multiTotals = cartTotals(twoSp);
eq('several cards: rows per type', statutoryDiscountRows(twoSp, multiTotals).map((r) => r.label), ['SC 20%', 'Solo Parent 10%']);

// ---- the payload ---------------------------------------------------------------------------------------------------
const single = statutoryFields({ ...spState, lines: spState.lines });
check('one card → statutory_discount only', single.statutory_discount != null && single.statutory_cards === undefined);
eq('Solo Parent payload: rate / VAT / extras', {
  rate: single.statutory_discount?.rate,
  vat_exempt: single.statutory_discount?.vat_exempt,
  children: single.statutory_discount?.children,
  rx: single.statutory_discount?.rx_in_child_name,
  expiry: single.statutory_discount?.id_expiry_date,
}, { rate: '10.00', vat_exempt: true, children: [{ name: 'Bea', birth_date: '2022-01-01' }], rx: null, expiry: '2030-01-01' });
const old = statutoryFields(state({ statutoryConfig: LEGACY_STATUTORY_CONFIG, lines: [line(1)], statutory: card({ type: 'SENIOR' }) }));
check('older server → no rate / vat_exempt sent', old.statutory_discount != null && !('rate' in old.statutory_discount) && !('vat_exempt' in old.statutory_discount));
const multi = statutoryFields(twoSp);
eq('several cards → statutory_cards in order, no statutory_discount', [multi.statutory_discount, multi.statutory_cards?.map((c) => c.type)], [null, ['SENIOR', 'SOLO_PARENT']]);

// The recorded payload re-priced (receipt / reprint) = the cart's figures.
const payloadOf = (s: S, fields: Pick<SalePayload, 'statutory_discount' | 'statutory_cards'>, multiCard: boolean): SalePayload =>
  ({
    lines: s.lines.map((l) => ({ sku_id: l.skuId, quantity: l.quantity, unit_price: l.unitPriceText, ...(multiCard ? { statutory_type: lineCardType(s, l) } : {}) })),
    transaction_discount_amount: '0.00',
    prices_include_vat: s.pricesIncludeVat,
    ...fields,
  }) as unknown as SalePayload;
const flagsOf = (s: S) => (id: number) => {
  const l = s.lines.find((x) => x.skuId === id)!;
  return { isVatable: l.isVatable, scPwdEligible: l.scPwdEligible, soloParentEligible: l.soloParentEligible };
};
const pick = (t: ReturnType<typeof cartTotals>) => [t.subtotal, t.totalStatutoryDiscount, t.totalVat, t.grandTotal, t.vatExemptSales];
eq('reprint of the NAAC sale = cart', pick(computePayloadTotals(payloadOf(naac, statutoryFields(naac), false), flagsOf(naac))), pick(tn));
eq('reprint of the Solo Parent sale = cart', pick(computePayloadTotals(payloadOf(spState, single, false), flagsOf(spState))), pick(ts));
const multiPayload = payloadOf(twoSp, multi, true);
eq('reprint of the two-card sale: line types', payloadLineCardTypes(multiPayload, flagsOf(twoSp)), ['SENIOR', 'SOLO_PARENT', 'SENIOR', null, null]);
eq('reprint of the two-card sale = cart', pick(computePayloadTotals(multiPayload, flagsOf(twoSp))), pick(multiTotals));
// An older Senior payload (no rate / vat_exempt) still prices at 20 %, VAT-exempt.
const seniorOld = state({ statutoryConfig: LEGACY_STATUTORY_CONFIG, lines: [line(1)], statutory: card({ type: 'SENIOR' }) });
eq('older Senior payload re-prices as before', pick(computePayloadTotals(payloadOf(seniorOld, old, false), flagsOf(seniorOld))), pick(cartTotals(seniorOld)));

// ---- promo vs a card ----------------------------------------------------------------------------------------------
const promoLine = line(1, { quantity: 1, unitPriceText: '100.00', unitPrice: 100, promo: { id: 9, name: 'Sale', price: 85, priceText: '85.00', terms: '15% off' } as never });
const naacPromo = state({ pricesIncludeVat: false, lines: [promoLine], statutory: card({ type: 'NAAC' }) });
eq('NAAC promo vs 20 % (VAT charged both ways)', promoCardComparison(naacPromo, promoLine), { promoTotal: 95.2, cardTotal: 89.6, better: 'CARD' });
const seniorPromo = state({ pricesIncludeVat: false, lines: [promoLine], statutory: card({ type: 'SENIOR' }) });
eq('Senior promo vs 20 % (shared compareScPwd)', promoCardComparison(seniorPromo, promoLine), { promoTotal: 85, cardTotal: 80, better: 'CARD' });

console.log(failures === 0 ? `${checks}/${checks} checks passed` : `${failures} of ${checks} checks FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
