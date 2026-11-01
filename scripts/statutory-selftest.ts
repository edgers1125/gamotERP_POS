// Self-test of the statutory discounts on the till (BIR Phase 2 + 2b — GamotERP docs/plans/bir-statutory-discounts-contract.md)
// — pure code, no device or server:
//   * src/sale/statutory.ts — the rules from the bootstrap (older server → Senior / PWD only), each card's checks (expiry
//     per type, Solo Parent children ≤ 6 on the sale day), the card payload (rate / vat_exempt only for a server that sent
//     the rules; Solo Parent fields only on a Solo Parent card), a client's card on record;
//   * src/sale/cartMath.ts — the line → card rule (== the shared assignStatutoryLines), the cart's totals with each type's
//     rate / VAT (NAAC VAT charged, Solo Parent 10 % exempt), the sale's card checks, the payload's statutory fields
//     (one card → statutory_discount; several → statutory_cards + lines[].statutory_type);
//   * src/sale/totals.ts — a recorded payload re-priced (receipt / reprint) gives the same figures as the cart;
//   * src/sale/promos.ts — the promo-vs-card comparison at the card's rate.
// The per-line maths itself is checked against the backend's vectors by vat-vectors-selftest.ts / withholding-vectors-selftest.ts.
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   npx -y tsx --tsconfig ./tsconfig.json scripts/statutory-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import type { PosBootstrap, PosClient, SalePayload } from '@pos-api/contract';
import { assignStatutoryLines, STATUTORY_TYPES, type StatutoryType } from '@shared/statutory-rules';
import type { CartLine, CartState } from '../src/sale/cart';
import { cartTotals, lineStatutoryType, multiCard, statutoryCardsProblem, statutoryDiscountRows, statutoryPayloadFields } from '../src/sale/cartMath';
import { scPwdComparison } from '../src/sale/promos';
import {
  clientStatutoryBlock,
  EMPTY_STATUTORY,
  LEGACY_STATUTORY_CONFIG,
  offeredStatutoryTypes,
  statutoryConfigOf,
  statutoryPayload,
  statutoryProblem,
  type StatutoryConfig,
  type StatutoryDraft,
} from '../src/sale/statutory';
import { computePayloadTotals, NO_DISCOUNT, payloadStatutoryLines, totalsPayload } from '../src/sale/totals';

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

// ---- the rules from the bootstrap -------------------------------------------------------------------------------------
const bootstrap = (over: Partial<Record<StatutoryType, { enabled?: boolean; rate?: string; vat_exempt?: boolean }>> = {}, oneTypePerSale = true) =>
  ({
    statutory_discounts: {
      one_type_per_sale: oneTypePerSale,
      types: STATUTORY_TYPES.map((type) => {
        const d = { SENIOR: ['20.00', true, true], PWD: ['20.00', true, true], NAAC: ['20.00', false, true], SOLO_PARENT: ['10.00', true, true], MEDAL_OF_VALOR: ['20.00', false, false] }[type] as [string, boolean, boolean];
        return {
          type,
          enabled: over[type]?.enabled ?? d[2],
          rate: over[type]?.rate ?? d[0],
          vat_exempt: over[type]?.vat_exempt ?? d[1],
          fixed_by_law: type === 'SENIOR' || type === 'PWD',
          eligible_flag: type === 'SOLO_PARENT' ? 'solo_parent_eligible' : 'sc_pwd_eligible',
        };
      }),
    },
  }) as unknown as PosBootstrap;

const legacy = statutoryConfigOf({} as PosBootstrap);
eq('older server → legacy config', legacy, LEGACY_STATUTORY_CONFIG);
eq('older server → Senior / PWD only', offeredStatutoryTypes(legacy), ['SENIOR', 'PWD']);
const cfg = statutoryConfigOf(bootstrap());
eq('defaults: MoV off', offeredStatutoryTypes(cfg), ['SENIOR', 'PWD', 'NAAC', 'SOLO_PARENT']);
eq('defaults: Solo Parent 10 % exempt', cfg.rules.SOLO_PARENT, { enabled: true, ratePercent: 10, vatExempt: true });
eq('defaults: NAAC 20 % VAT charged', cfg.rules.NAAC, { enabled: true, ratePercent: 20, vatExempt: false });
check('defaults: one card per sale', cfg.oneTypePerSale && cfg.known);
const cfgMulti = statutoryConfigOf(bootstrap({ MEDAL_OF_VALOR: { enabled: true } }, false));
eq('MoV enabled + several cards', [offeredStatutoryTypes(cfgMulti).length, cfgMulti.oneTypePerSale], [5, false]);
eq('unreadable rate keeps the default', statutoryConfigOf(bootstrap({ NAAC: { rate: 'abc' } })).rules.NAAC.ratePercent, 20);

// ---- cards ------------------------------------------------------------------------------------------------------------
const SALE_DAY = '2026-11-01';
const card = (type: StatutoryType, over: Partial<StatutoryDraft> = {}): StatutoryDraft => ({
  ...EMPTY_STATUTORY,
  type,
  idNumber: `${type}-1`,
  firstName: 'Ana',
  lastName: 'Cruz',
  expiryDate: type === 'SENIOR' ? '' : '2099-12-31',
  ...(type === 'SOLO_PARENT' ? { children: [{ name: 'Ben', birthDate: '2022-05-01' }] } : {}),
  ...over,
});
eq('Senior ready', statutoryProblem(card('SENIOR'), SALE_DAY), null);
eq('PWD needs an expiry', statutoryProblem(card('PWD', { expiryDate: '' }), SALE_DAY), 'Enter the PWD ID’s expiry date.');
eq('Solo Parent needs an expiry', statutoryProblem(card('SOLO_PARENT', { expiryDate: '' }), SALE_DAY), 'Enter the Solo Parent ID’s expiry date.');
eq('NAAC expiry optional', statutoryProblem(card('NAAC', { expiryDate: '' }), SALE_DAY), null);
check('NAAC expired refused', (statutoryProblem(card('NAAC', { expiryDate: '2020-01-01' }), SALE_DAY) ?? '').includes('expired on'));
check('MoV expired refused', (statutoryProblem(card('MEDAL_OF_VALOR', { expiryDate: '2020-01-01' }), SALE_DAY) ?? '').includes('expired on'));
eq('Solo Parent needs a child', statutoryProblem(card('SOLO_PARENT', { children: [{ name: '', birthDate: '' }] }), SALE_DAY), 'Add the child the Solo Parent discount is for (name and birth date).');
eq('Solo Parent child 6 years old today is fine', statutoryProblem(card('SOLO_PARENT', { children: [{ name: 'Ben', birthDate: '2020-11-02' }] }), SALE_DAY), null);
check('Solo Parent child turning 7 today refused', (statutoryProblem(card('SOLO_PARENT', { children: [{ name: 'Ben', birthDate: '2019-11-01' }] }), SALE_DAY) ?? '').includes('over 6 years old'));
check('Solo Parent child birth date required', (statutoryProblem(card('SOLO_PARENT', { children: [{ name: 'Ben', birthDate: '' }] }), SALE_DAY) ?? '').includes('birth date'));

// Payload: rate / vat_exempt only when the server sent the rules; Solo Parent extras only on a Solo Parent card.
const spPayload = statutoryPayload(card('SOLO_PARENT', { bookletNumber: ' B-77 ', rxInChildName: true }), cfg.rules.SOLO_PARENT);
eq('SP payload: rate / VAT / booklet / children / attestation', [spPayload.rate, spPayload.vat_exempt, spPayload.booklet_number, spPayload.children, spPayload.rx_in_child_name, spPayload.id_expiry_date], ['10.00', true, 'B-77', [{ name: 'Ben', birth_date: '2022-05-01' }], true, '2099-12-31']);
const legacyPayload = statutoryPayload(card('SENIOR'), null);
eq('legacy payload: as before (no new fields)', ['rate', 'vat_exempt', 'booklet_number', 'children', 'rx_in_child_name'].filter((k) => k in legacyPayload), []);
eq('Senior payload: no expiry', legacyPayload.id_expiry_date, null);
eq('NAAC payload: expiry sent', statutoryPayload(card('NAAC'), cfg.rules.NAAC).id_expiry_date, '2099-12-31');
check('NAAC payload: no Solo Parent fields', !('children' in statutoryPayload(card('NAAC'), cfg.rules.NAAC)));

// A client's card on record.
const client = (type: StatutoryType, expiry: string | null): PosClient => ({ id: 1, first_name: 'Ana', last_name: 'Cruz', statutory_type: type, statutory_id_number: 'X1', statutory_id_issuer: null, id_expiry_date: expiry }) as unknown as PosClient;
eq('client Senior card usable', clientStatutoryBlock(client('SENIOR', null), cfg), null);
eq('client NAAC card without expiry usable', clientStatutoryBlock(client('NAAC', null), cfg), null);
check('client PWD card without expiry blocked', clientStatutoryBlock(client('PWD', null), cfg) !== null);
check('client Solo Parent card always opens the card (child)', clientStatutoryBlock(client('SOLO_PARENT', '2099-01-01'), cfg) !== null);
check('client MoV card blocked while MoV is off', clientStatutoryBlock(client('MEDAL_OF_VALOR', null), cfg) !== null);
check('client NAAC card blocked on an older server', clientStatutoryBlock(client('NAAC', null), legacy) !== null);

// ---- cart lines + the line → card rule ------------------------------------------------------------------------------
let sku = 0;
const line = (unitPrice: number, quantity: number, f: { vat?: boolean; sc?: boolean; sp?: boolean; rx?: boolean; choice?: CartLine['cardChoice'] } = {}): CartLine => ({
  skuId: ++sku,
  skuCode: `S${sku}`,
  name: `Item ${sku}`,
  packQuantity: 1,
  unitPriceText: unitPrice.toFixed(2),
  unitPrice,
  isVatable: f.vat ?? true,
  scPwdEligible: f.sc ?? true,
  soloParentEligible: f.sp ?? false,
  cardChoice: f.choice ?? null,
  modelId: sku,
  modelName: `Item ${sku}`,
  rxRequired: f.rx ?? false,
  dangerousDrug: false,
  quantity,
  discount: NO_DISCOUNT,
  promo: null,
  promoChoice: null,
});
type S = Pick<CartState, 'lines' | 'txDiscount' | 'statutory' | 'extraCards' | 'statutoryConfig' | 'pricesIncludeVat'>;
const state = (lines: CartLine[], cards: StatutoryDraft[], config: StatutoryConfig, pricesIncludeVat = false): S => ({
  lines,
  txDiscount: NO_DISCOUNT,
  statutory: cards[0] ?? null,
  extraCards: cards.slice(1),
  statutoryConfig: config,
  pricesIncludeVat,
});

// One card: every eligible line gets it — Solo Parent only on solo_parent_eligible items.
{
  const ls = [line(100, 1, { sp: true }), line(100, 1, { sp: false })];
  const s = state(ls, [card('SOLO_PARENT')], cfg);
  eq('one SP card: only the SP-eligible line', ls.map((l) => lineStatutoryType(s, l)), ['SOLO_PARENT', null]);
  const s2 = state(ls, [card('SENIOR')], cfg);
  eq('one Senior card: sc_pwd_eligible lines', ls.map((l) => lineStatutoryType(s2, l)), ['SENIOR', 'SENIOR']);
  check('one card is not multi', !multiCard(s2));
}
// Several cards: default = first eligible card; explicit pick; NONE; a pick the item isn't eligible for → default.
{
  const ls = [line(100, 1, { sp: true }), line(100, 1, { sp: true, choice: 'SOLO_PARENT' }), line(100, 1, { choice: 'NONE' }), line(100, 1, { sp: false, choice: 'SOLO_PARENT' }), line(100, 1, { sc: false })];
  const s = state(ls, [card('SENIOR'), card('SOLO_PARENT')], cfgMulti);
  eq('multi: per-line cards', ls.map((l) => lineStatutoryType(s, l)), ['SENIOR', 'SOLO_PARENT', null, 'SENIOR', null]);
  // What the device sends must be what the server assigns (the shared rule, explicit mode).
  const named = ls.map((l) => lineStatutoryType(s, l));
  const server = assignStatutoryLines(['SENIOR', 'SOLO_PARENT'], true, ls.map((l, i) => ({ statutoryType: named[i], model: { sc_pwd_eligible: l.scPwdEligible, solo_parent_eligible: l.soloParentEligible } })));
  eq('multi: server assigns the same cards, no issues', [server.types, server.issues], [named, []]);
}
// Exhaustive parity over flags × choices × card sets (one card → implicit mode; several → explicit).
{
  const choices: CartLine['cardChoice'][] = [null, 'NONE', ...STATUTORY_TYPES];
  const cardSets: StatutoryType[][] = [['SENIOR'], ['SOLO_PARENT'], ['NAAC', 'SOLO_PARENT'], ['PWD', 'SOLO_PARENT', 'MEDAL_OF_VALOR']];
  let mismatches = 0;
  for (const set of cardSets)
    for (const sc of [true, false])
      for (const sp of [true, false])
        for (const choice of choices) {
          const l = line(10, 1, { sc, sp, choice });
          const s = state([l], set.map((t) => card(t)), cfgMulti);
          const got = lineStatutoryType(s, l);
          const want = assignStatutoryLines(set, set.length > 1, [{ statutoryType: got, model: { sc_pwd_eligible: sc, solo_parent_eligible: sp } }]).types[0];
          if (got !== want) mismatches++;
        }
  eq('line → card parity with assignStatutoryLines (128 cases)', mismatches, 0);
}

// ---- totals with each type's rule ------------------------------------------------------------------------------------
{
  // The contract's example: 10 × 10.71 VAT-inclusive NAAC → 120.00 − 24.00 = 96.00, VAT 10.29.
  const s = state([line(10.71, 10)], [card('NAAC')], cfg, true);
  const t = cartTotals(s);
  eq('NAAC VAT-inclusive 10 × 10.71', [t.subtotal, t.totalStatutoryDiscount, t.totalVat, t.grandTotal, t.vatExemptSales], [120, 24, 10.29, 96, 0]);
  eq('NAAC row label', statutoryDiscountRows(s, t), [{ type: 'NAAC', label: 'NAAC 20%', amount: 24 }]);
  // Before-VAT NAAC: 20 % of the base, then VAT: 100 → 80 + 9.60.
  const tb = cartTotals(state([line(100, 1)], [card('NAAC')], cfg));
  eq('NAAC before-VAT 100', [tb.totalStatutoryDiscount, tb.totalVat, tb.grandTotal], [20, 9.6, 89.6]);
  // Solo Parent 10 % VAT-exempt, VAT-inclusive: shown 112 → base 100 → 10 off → 90.00, no VAT.
  const ts = cartTotals(state([line(100, 1, { sp: true })], [card('SOLO_PARENT')], cfg, true));
  eq('Solo Parent VAT-inclusive 112', [ts.subtotal, ts.totalStatutoryDiscount, ts.totalVat, ts.grandTotal, ts.vatExemptSales], [112, 10, 0, 90, 90]);
  // A company that made NAAC exempt at 15 %: before-VAT 100 → 85, no VAT.
  const cfgNaacExempt = statutoryConfigOf(bootstrap({ NAAC: { rate: '15.00', vat_exempt: true } }));
  const tx = cartTotals(state([line(100, 1)], [card('NAAC')], cfgNaacExempt));
  eq('NAAC set to 15 % exempt', [tx.totalStatutoryDiscount, tx.totalVat, tx.grandTotal], [15, 0, 85]);
  // Several cards: Senior line 100 → 80 exempt; Solo Parent line 100 → 90 exempt; ordinary line 100 + 12 VAT.
  const ms = state([line(100, 1), line(100, 1, { sp: true, choice: 'SOLO_PARENT' }), line(100, 1, { sc: false })], [card('SENIOR'), card('SOLO_PARENT')], cfgMulti);
  const tm = cartTotals(ms);
  eq('multi Senior + SP', [tm.totalStatutoryDiscount, tm.totalVat, tm.grandTotal, tm.vatExemptSales], [30, 12, 282, 170]);
  eq('multi rows', statutoryDiscountRows(ms, tm).map((r) => [r.label, r.amount]), [['Senior 20%', 20], ['Solo Parent 10%', 10]]);
}

// ---- the sale's card checks -------------------------------------------------------------------------------------------
{
  const spLine = line(100, 1, { sp: true });
  eq('ready', statutoryCardsProblem(state([spLine], [card('SOLO_PARENT')], cfg), SALE_DAY), null);
  eq('no eligible item', statutoryCardsProblem(state([line(100, 1, { sp: false })], [card('SOLO_PARENT')], cfg), SALE_DAY), 'None of these items is eligible for the Solo Parent discount.');
  check('type turned off', (statutoryCardsProblem(state([line(100, 1)], [card('MEDAL_OF_VALOR')], cfg), SALE_DAY) ?? '').includes('turned off'));
  check('NAAC on an older server refused', (statutoryCardsProblem(state([line(100, 1)], [card('NAAC')], legacy), SALE_DAY) ?? '').includes('turned off'));
  check('several cards while one per sale', (statutoryCardsProblem(state([line(100, 1), spLine], [card('SENIOR'), card('SOLO_PARENT')], cfg), SALE_DAY) ?? '').startsWith('Only one statutory discount per sale'));
  check('duplicate type', (statutoryCardsProblem(state([line(100, 1)], [card('SENIOR'), card('SENIOR', { idNumber: 'Z' })], cfgMulti), SALE_DAY) ?? '').includes('one card per type'));
  eq('card no line uses', statutoryCardsProblem(state([line(100, 1, { sp: false })], [card('SENIOR'), card('SOLO_PARENT')], cfgMulti), SALE_DAY), 'No item gets the Solo Parent discount — choose its items or remove the card.');
  check('multi card detail prefixed', (statutoryCardsProblem(state([line(100, 1), spLine], [card('SENIOR'), card('SOLO_PARENT', { expiryDate: '' })], cfgMulti), SALE_DAY) ?? '').startsWith('Solo Parent card: '));
  const rxSp = line(100, 1, { sp: true, rx: true });
  check('SP Rx line needs the attestation', (statutoryCardsProblem(state([rxSp], [card('SOLO_PARENT')], cfg), SALE_DAY) ?? '').includes('in the child’s name'));
  eq('SP Rx line attested', statutoryCardsProblem(state([rxSp], [card('SOLO_PARENT', { rxInChildName: true })], cfg), SALE_DAY), null);
  eq('Rx line on the Senior card needs no attestation', statutoryCardsProblem(state([line(100, 1, { rx: true, choice: 'SENIOR' }), line(100, 1, { sp: true, choice: 'SOLO_PARENT' })], [card('SENIOR'), card('SOLO_PARENT')], cfgMulti), SALE_DAY), null);
}

// ---- payload fields + re-pricing a recorded payload (receipt / reprint) ------------------------------------------------
function recorded(s: S): SalePayload {
  const several = multiCard(s);
  return {
    lines: s.lines.map((l) => ({
      sku_id: l.skuId,
      quantity: l.quantity,
      unit_price: l.unitPriceText,
      ...(several ? { statutory_type: lineStatutoryType(s, l) } : {}),
    })),
    transaction_discount_amount: '0.00',
    transaction_discount_percent: null,
    prices_include_vat: s.pricesIncludeVat,
    ...statutoryPayloadFields(s),
    totals: totalsPayload(cartTotals(s)),
  } as unknown as SalePayload;
}
const flagsOf = (lines: CartLine[]) => (id: number) => {
  const l = lines.find((x) => x.skuId === id)!;
  return { isVatable: l.isVatable, scPwdEligible: l.scPwdEligible, soloParentEligible: l.soloParentEligible };
};
{
  const ls = [line(10.71, 10)];
  const s = state(ls, [card('NAAC')], cfg, true);
  const p = recorded(s);
  eq('one card → statutory_discount only', [p.statutory_discount?.type, p.statutory_discount?.rate, p.statutory_discount?.vat_exempt, 'statutory_cards' in p], ['NAAC', '20.00', false, false]);
  eq('one card: reprint totals = cart totals', totalsPayload(computePayloadTotals(p, flagsOf(ls))), p.totals);
}
{
  const ls = [line(100, 1), line(100, 2, { sp: true, choice: 'SOLO_PARENT' }), line(50, 1, { sc: false }), line(80, 1, { choice: 'NONE' })];
  const s = state(ls, [card('SENIOR'), card('SOLO_PARENT'), card('NAAC')], cfgMulti, true);
  // NAAC card with no line → the card check refuses it; drop it for the payload test.
  check('unused NAAC card refused', statutoryCardsProblem(s, SALE_DAY) !== null);
  const s2 = state(ls, [card('SENIOR'), card('SOLO_PARENT')], cfgMulti, true);
  const p = recorded(s2);
  eq('several → statutory_cards in order, no statutory_discount', [p.statutory_discount, p.statutory_cards?.map((c) => [c.type, c.rate, c.vat_exempt])], [null, [['SENIOR', '20.00', true], ['SOLO_PARENT', '10.00', true]]]);
  eq('several → lines name their card', p.lines.map((l) => l.statutory_type), ['SENIOR', 'SOLO_PARENT', null, null]);
  eq('several: reprint totals = cart totals', totalsPayload(computePayloadTotals(p, flagsOf(ls))), p.totals);
  eq('several: reprint line cards', payloadStatutoryLines(p, flagsOf(ls)).map((x) => x && [x.type, x.ratePercent]), [['SENIOR', 20], ['SOLO_PARENT', 10], null, null]);
}
{
  // A sale recorded by an older app (no rate / vat_exempt): Senior re-priced at 20 % exempt as before.
  const ls = [line(100, 1)];
  const p = recorded(state(ls, [card('SENIOR')], legacy));
  check('legacy payload has no rate', p.statutory_discount != null && !('rate' in p.statutory_discount));
  eq('legacy reprint', computePayloadTotals(p, flagsOf(ls)).grandTotal, 80);
}

// ---- promo vs card at the card's rate ---------------------------------------------------------------------------------
{
  const promoLine = { ...line(100, 1, { sp: true }), promo: { id: 1, name: 'P', price: 92, priceText: '92.00' } } as unknown as CartLine;
  eq('promo vs Senior 20 %', scPwdComparison(promoLine), { promo_total: 92, scpwd_total: 80, better: 'SCPWD' });
  eq('promo vs Solo Parent 10 %', scPwdComparison(promoLine, 10), { promo_total: 92, scpwd_total: 90, better: 'SCPWD' });
  eq('promo vs a 5 % card', scPwdComparison(promoLine, 5), { promo_total: 92, scpwd_total: 95, better: 'PROMO' });
}

console.log(failures === 0 ? `${checks}/${checks} checks passed` : `${failures} of ${checks} checks FAILED`);
if (failures > 0) process.exitCode = 1;
