// The sale's statutory cards (BIR Phase 2 / 2b — src/sale/statutory.ts, GamotERP docs/plans/bir-statutory-discounts-
// contract.md): which line gets which card (the backend's own `assignStatutoryLines`), what each line is charged with its
// card's rate + VAT treatment (the shared pricing code), the cart's totals, the discount rows, the checks before charging
// and the payload's card fields. Pure (no store, no native code) so scripts/statutory-selftest.ts can run it; the zustand
// cart (cart.ts) re-exports everything here.
import { assignStatutoryLines, STATUTORY_TYPES, statutoryLineEligible } from '@shared/statutory-rules';
import type { SalePayload } from '@pos-api/contract';
import type { CartLine, CartState } from './cart';
import { round2 } from './money';
import { chargedLine, scPwdComparison, type ChargedLine } from './promos';
import {
  discountRowLabel,
  statutoryPayload,
  statutoryProblem,
  statutoryTypeLabel,
  type StatutoryDraft,
  type StatutoryType,
} from './statutory';
import { computeCartTotals, hasDiscount, NO_DISCOUNT, type SaleTotals } from './totals';

export type CardState = Pick<CartState, 'statutory' | 'extraCards'>;
export type PricingState = CardState & Pick<CartState, 'statutoryConfig'>;

/** The sale's cards in order (card 0 = the client's). */
export function saleCards(state: CardState): StatutoryDraft[] {
  return state.statutory ? [state.statutory, ...state.extraCards] : [];
}

/** Several cards → each line names its card (statutory_cards); one card → every eligible line gets it (statutory_discount). */
export function isMultiCard(state: CardState): boolean {
  return state.statutory !== null && state.extraCards.length > 0;
}

function lineModel(line: Pick<CartLine, 'scPwdEligible' | 'soloParentEligible'>) {
  return { sc_pwd_eligible: line.scPwdEligible, solo_parent_eligible: line.soloParentEligible };
}

/** The line is eligible for this card type (the backend's flag rule). */
export function lineEligibleFor(type: StatutoryType, line: Pick<CartLine, 'scPwdEligible' | 'soloParentEligible'>): boolean {
  return statutoryLineEligible(type, lineModel(line));
}

/** The card a line names with several cards on the sale: its pick, else the first card it's eligible for. */
function namedCard(cards: readonly StatutoryDraft[], line: CartLine): StatutoryType | null {
  if (line.cardPick === 'NONE') return null;
  if (line.cardPick !== undefined && cards.some((c) => c.type === line.cardPick)) return line.cardPick;
  return cards.find((c) => lineEligibleFor(c.type, line))?.type ?? null;
}

/** Which card type this line gets (null = none) — THE backend rule (`assignStatutoryLines`). */
export function lineCardType(state: CardState, line: CartLine): StatutoryType | null {
  const cards = saleCards(state);
  if (cards.length === 0) return null;
  const explicit = cards.length > 1;
  const named = explicit ? namedCard(cards, line) : null;
  return assignStatutoryLines(cards.map((c) => c.type), explicit, [{ statutoryType: named, model: lineModel(line) }]).types[0] ?? null;
}

export function isStatutoryLine(state: CardState, line: CartLine): boolean {
  return lineCardType(state, line) !== null;
}

/** The state with what a card can't be combined with cleared on the lines it now discounts (+ the transaction discount). */
export function withCardsApplied<S extends PricingState & Pick<CartState, 'lines' | 'txDiscount' | 'txDiscountReason'>>(s: S): Partial<CartState> {
  const lines = s.lines.map((l) => (lineCardType(s, l) !== null && hasDiscount(l.discount) ? { ...l, discount: NO_DISCOUNT } : l));
  const anyCard = s.statutory !== null;
  return {
    statutory: s.statutory,
    extraCards: s.extraCards,
    lines,
    ...(anyCard ? { txDiscount: NO_DISCOUNT, txDiscountReason: '' } : {}),
  };
}

/** What the line is charged: the promo / regular price (a statutory promo line by the cashier's choice) + its card's rate
 * and VAT treatment from the company's rules (a PROMO choice: rate 0, the type's VAT treatment). */
export function chargedLineOf(state: PricingState, line: CartLine): ChargedLine & { statutoryVatExempt?: boolean } {
  const type = lineCardType(state, line);
  const charged = chargedLine(line, type !== null);
  if (type === null) return charged;
  const rule = state.statutoryConfig.rules[type];
  return { ...charged, statutoryDiscountRate: charged.statutoryDiscountRate ?? rule.ratePercent / 100, statutoryVatExempt: rule.vatExempt };
}

export function cartTotals(state: Pick<CartState, 'lines' | 'txDiscount' | 'statutory' | 'extraCards' | 'statutoryConfig' | 'pricesIncludeVat'>): SaleTotals {
  return computeCartTotals(
    state.lines.map((l) => {
      const charged = chargedLineOf(state, l);
      return {
        quantity: l.quantity,
        unitPrice: charged.unitPrice,
        isVatable: l.isVatable,
        isStatutory: isStatutoryLine(state, l),
        ...(charged.statutoryDiscountRate !== undefined ? { statutoryDiscountRate: charged.statutoryDiscountRate } : {}),
        ...(charged.statutoryVatExempt !== undefined ? { statutoryVatExempt: charged.statutoryVatExempt } : {}),
        itemDiscount: l.discount,
      };
    }),
    state.txDiscount,
    state.statutory !== null,
    state.pricesIncludeVat,
  );
}

/** The statutory discount row(s): one per card type actually discounting a line ("SC 20%" → amount). */
export function statutoryDiscountRows(state: PricingState & Pick<CartState, 'lines'>, totals: SaleTotals): { type: StatutoryType; label: string; amount: number }[] {
  const byType = new Map<StatutoryType, number>();
  state.lines.forEach((l, i) => {
    const type = lineCardType(state, l);
    const amount = totals.lines[i]?.statutoryDiscountAmount ?? 0;
    if (type !== null && amount > 0) byType.set(type, round2((byType.get(type) ?? 0) + amount));
  });
  return STATUTORY_TYPES.filter((t) => byType.has(t)).map((t) => ({ type: t, label: discountRowLabel(state.statutoryConfig, t), amount: byType.get(t)! }));
}

/** A statutory line's discount as named to the cashier ("Senior/PWD 20%" for SC / PWD as before, "Solo Parent 10%"). */
export function lineDiscountName(state: PricingState, line: CartLine): string {
  const type = lineCardType(state, line);
  if (type === null) return '';
  return type === 'SENIOR' || type === 'PWD' ? 'Senior/PWD 20%' : discountRowLabel(state.statutoryConfig, type);
}

/** The card a line gets, for the line row (null = none). */
export function lineCardInfo(state: PricingState, line: CartLine): { label: string; name: string; vatExempt: boolean } | null {
  const type = lineCardType(state, line);
  if (type === null) return null;
  const label = type === 'SENIOR' || type === 'PWD' ? 'SC/PWD 20%' : discountRowLabel(state.statutoryConfig, type);
  return { label, name: lineDiscountName(state, line), vatExempt: state.statutoryConfig.rules[type].vatExempt };
}

/** Several cards on the sale: the line's card choices (the cards it's eligible for + None); undefined = no picker. */
export function lineCardOptions(state: CardState, line: CartLine): { value: StatutoryType | 'NONE'; label: string; selected: boolean }[] | undefined {
  if (!isMultiCard(state)) return undefined;
  const eligible = saleCards(state).filter((c) => lineEligibleFor(c.type, line));
  if (eligible.length === 0) return undefined;
  const current = lineCardType(state, line);
  return [
    ...eligible.map((c) => ({ value: c.type, label: statutoryTypeLabel(c.type), selected: current === c.type })),
    { value: 'NONE' as const, label: 'None', selected: current === null },
  ];
}

export interface PromoCardComparison {
  promoTotal: number;
  cardTotal: number;
  better: 'PROMO' | 'CARD' | 'EQUAL';
}

/** A statutory promo line: what the customer pays for it with the promo vs with the card's discount. Senior / PWD: the
 * shared compareScPwd (as before); other types: the shared pricing code on this one line both ways (the type's rate and
 * VAT treatment — e.g. NAAC charges VAT, so the 20 % alone doesn't tell). */
export function promoCardComparison(state: PricingState & Pick<CartState, 'pricesIncludeVat'>, line: CartLine): PromoCardComparison | null {
  const type = lineCardType(state, line);
  if (type === null || !line.promo) return null;
  if (type === 'SENIOR' || type === 'PWD') {
    const c = scPwdComparison(line);
    if (!c) return null;
    return { promoTotal: c.promo_total, cardTotal: c.scpwd_total, better: c.better === 'SCPWD' ? 'CARD' : c.better };
  }
  const rule = state.statutoryConfig.rules[type];
  const one = (unitPrice: number, rate: number) =>
    computeCartTotals(
      [{ quantity: line.quantity, unitPrice, isVatable: line.isVatable, isStatutory: true, statutoryDiscountRate: rate, statutoryVatExempt: rule.vatExempt, itemDiscount: NO_DISCOUNT }],
      NO_DISCOUNT,
      true,
      state.pricesIncludeVat,
    ).grandTotal;
  const promoTotal = one(line.promo.price, 0);
  const cardTotal = one(line.unitPrice, rule.ratePercent / 100);
  const p = Math.round(promoTotal * 100);
  const k = Math.round(cardTotal * 100);
  return { promoTotal, cardTotal, better: p < k ? 'PROMO' : k < p ? 'CARD' : 'EQUAL' };
}

/** The sale's card types as one short label ("Senior Citizen", "Senior Citizen + Solo Parent"). */
export function cardsLabel(state: CardState): string {
  return saleCards(state).map((c) => statutoryTypeLabel(c.type)).join(' + ');
}

/** Every card of the sale is usable and gives at least one line its discount (null = fine). `saleDay` = Manila day. */
export function statutoryCardsProblem(state: Pick<CartState, 'lines' | 'statutory' | 'extraCards' | 'statutoryConfig'>, saleDay?: string): string | null {
  const cards = saleCards(state);
  if (cards.length > 1 && state.statutoryConfig.oneTypePerSale) return 'Only one statutory discount per sale — remove the extra cards (Settings → Statutory discounts on the web).';
  const seen = new Set<StatutoryType>();
  for (const card of cards) {
    if (seen.has(card.type)) return `This sale already has a ${statutoryTypeLabel(card.type)} card — one card per type.`;
    seen.add(card.type);
    const lines = state.lines.filter((l) => lineCardType(state, l) === card.type);
    if (lines.length === 0) {
      return cards.length === 1
        ? `No item in the cart is eligible for the ${statutoryTypeLabel(card.type)} discount.`
        : `No item gets the ${statutoryTypeLabel(card.type)} discount — choose its items or remove the card.`;
    }
    const p = statutoryProblem(card, { config: state.statutoryConfig, saleDay, rxLine: lines.some((l) => l.rxRequired) });
    if (p) return cards.length === 1 ? p : `${statutoryTypeLabel(card.type)} card: ${p}`;
  }
  return null;
}

/** A line getting this card is a prescription item (Solo Parent attestation). */
export function cardHasRxLine(state: Pick<CartState, 'lines' | 'statutory' | 'extraCards'>, type: StatutoryType): boolean {
  return state.lines.some((l) => l.rxRequired && lineCardType(state, l) === type);
}

/** The sale's card(s) as sent: one card → statutory_discount (every eligible line gets it — unchanged for older servers);
 * several (Phase 2b, only while the server's one_type_per_sale is off) → statutory_cards, card 0 = the client's (each
 * line then says which card it gets — `lineCardType`). */
export function statutoryFields(state: Pick<CartState, 'lines' | 'statutory' | 'extraCards' | 'statutoryConfig'>): Pick<SalePayload, 'statutory_discount' | 'statutory_cards'> {
  const cards = saleCards(state).map((c) => statutoryPayload(c, state.statutoryConfig, cardHasRxLine(state, c.type)));
  if (cards.length === 0) return { statutory_discount: null };
  if (cards.length === 1) return { statutory_discount: cards[0]! };
  return { statutory_discount: null, statutory_cards: cards };
}
