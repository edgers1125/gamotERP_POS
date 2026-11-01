// The cart's derived money values — pure (no React Native / Expo imports), so the self-tests can run them
// (scripts/statutory-selftest.ts). Re-exported by cart.ts; call from components with useMemo.
// Statutory cards (GamotERP docs/plans/bir-statutory-discounts-contract.md §1, §2b, §5): card 0 = the sale client's card
// (`statutory`), further cards (`extraCards`) only while the company allows several; the line → card rule is the shared
// `@shared/statutory-rules` one, each type's rate / VAT treatment the frozen `statutoryConfig`'s.
import { statutoryLineEligible } from '@shared/statutory-rules';
import type { SalePayload } from '@pos-api/contract';
import type { CartLine, CartState } from './cart';
import { chargedLine, type ChargedLine } from './promos';
import { computeCartTotals, type SaleTotals } from './totals';
import { round2 } from './money';
import {
  ratePercentText,
  statutoryPayload,
  statutoryProblem,
  statutoryShortLabel,
  statutoryTypeLabel,
  type StatutoryDraft,
  type StatutoryType,
  type StatutoryTypeRule,
} from './statutory';

type CardsState = Pick<CartState, 'statutory' | 'extraCards'>;
type LineFlags = Pick<CartLine, 'scPwdEligible' | 'soloParentEligible'>;

/** The sale's cards in order (card 0 = the client's). */
export function saleCards(state: CardsState): StatutoryDraft[] {
  return state.statutory ? [state.statutory, ...state.extraCards] : [];
}

/** Several cards on the sale: each line names its card (payload `statutory_cards` + `lines[].statutory_type`). */
export function multiCard(state: CardsState): boolean {
  return state.statutory !== null && state.extraCards.length > 0;
}

function lineModel(line: LineFlags) {
  return { sc_pwd_eligible: line.scPwdEligible, solo_parent_eligible: line.soloParentEligible };
}

/** Whether the item is eligible for that card type (shared rule: Solo Parent → solo_parent_eligible, else sc_pwd_eligible). */
export function lineEligibleFor(type: StatutoryType, line: LineFlags): boolean {
  return statutoryLineEligible(type, lineModel(line));
}

/** The card types this line could get on this sale (the per-line picker's options). */
export function lineCardOptions(state: CardsState, line: LineFlags): StatutoryType[] {
  return saleCards(state).map((c) => c.type).filter((t) => lineEligibleFor(t, line));
}

/**
 * The card type a line gets (null = an ordinary line) — the shared line → card rule (`assignStatutoryLines`): one card →
 * every eligible line gets it; several → the card the line names (the cashier's pick, default the first card the item is
 * eligible for), when the sale carries it and the item is eligible.
 */
export function lineStatutoryType(state: CardsState, line: LineFlags & Pick<CartLine, 'cardChoice'>): StatutoryType | null {
  const types = saleCards(state).map((c) => c.type);
  if (types.length === 0) return null;
  if (types.length === 1) return lineEligibleFor(types[0]!, line) ? types[0]! : null;
  if (line.cardChoice === 'NONE') return null;
  if (line.cardChoice !== null && types.includes(line.cardChoice) && lineEligibleFor(line.cardChoice, line)) return line.cardChoice;
  return types.find((t) => lineEligibleFor(t, line)) ?? null;
}

export function isStatutoryLine(state: CardsState, line: CartLine): boolean {
  return lineStatutoryType(state, line) !== null;
}

/** The rule (rate / VAT) a statutory line is charged with — the frozen config's, by the line's card type. */
export function lineStatutoryRule(state: CardsState & Pick<CartState, 'statutoryConfig'>, line: CartLine): StatutoryTypeRule | null {
  const type = lineStatutoryType(state, line);
  return type === null ? null : state.statutoryConfig.rules[type];
}

/** "Senior 20%" / "Solo Parent 10%" — a line's card as chips / rows name it. */
export function cardDiscountName(type: StatutoryType, rule: StatutoryTypeRule): string {
  return `${statutoryShortLabel(type)} ${ratePercentText(rule.ratePercent)}`;
}

/** The statutory discount per card type, in card order — "Senior 20%", "Solo Parent 10%" (the totals rows on the till,
 * the customer display). Types whose lines took the promo instead (0.00) are left out. */
export function statutoryDiscountRows(
  state: Pick<CartState, 'lines' | 'statutory' | 'extraCards' | 'statutoryConfig'>,
  totals: SaleTotals,
): { type: StatutoryType; label: string; amount: number }[] {
  return saleCards(state)
    .map((card) => {
      const amount = round2(state.lines.reduce((sum, l, i) => (lineStatutoryType(state, l) === card.type ? sum + (totals.lines[i]?.statutoryDiscountAmount ?? 0) : sum), 0));
      return { type: card.type, label: cardDiscountName(card.type, state.statutoryConfig.rules[card.type]), amount };
    })
    .filter((r) => r.amount > 0);
}

/** What the line is charged (promo price, or the regular price; a statutory promo line by the cashier's choice). */
export function chargedLineOf(state: CardsState, line: CartLine): ChargedLine {
  return chargedLine(line, isStatutoryLine(state, line));
}

export function cartTotals(state: Pick<CartState, 'lines' | 'txDiscount' | 'statutory' | 'extraCards' | 'statutoryConfig' | 'pricesIncludeVat'>): SaleTotals {
  return computeCartTotals(
    state.lines.map((l) => {
      const charged = chargedLineOf(state, l);
      const rule = lineStatutoryRule(state, l);
      return {
        quantity: l.quantity,
        unitPrice: charged.unitPrice,
        isVatable: l.isVatable,
        isStatutory: rule !== null,
        // The card type's rate (0 when the cashier gave the promo price instead) and VAT treatment.
        ...(rule !== null ? { statutoryDiscountRate: charged.statutoryDiscountRate ?? rule.ratePercent / 100, statutoryVatExempt: rule.vatExempt } : {}),
        itemDiscount: l.discount,
      };
    }),
    state.txDiscount,
    state.statutory !== null,
    state.pricesIncludeVat,
  );
}

/**
 * The first problem with the sale's statutory cards (null = fine or none) — the checks the server would otherwise flag at
 * sync (contract §2b / §5): the type offered, one card per type (several only when the company allows it), each card's
 * own details (ID, expiry, Solo Parent children on `saleDay`), every card used by a line, and the Solo Parent Rx
 * attestation.
 */
export function statutoryCardsProblem(
  state: Pick<CartState, 'lines' | 'statutory' | 'extraCards' | 'statutoryConfig'>,
  saleDay?: string,
): string | null {
  const cards = saleCards(state);
  if (cards.length === 0) return null;
  const several = cards.length > 1;
  if (several && state.statutoryConfig.oneTypePerSale) return 'Only one statutory discount per sale — change this in Settings → Statutory discounts.';
  const seen = new Set<StatutoryType>();
  for (const card of cards) {
    const label = statutoryTypeLabel(card.type);
    if (!state.statutoryConfig.rules[card.type].enabled) return `The ${label} discount is turned off for your company (Settings → Statutory discounts).`;
    if (seen.has(card.type)) return `This sale already has a ${label} card — one card per type.`;
    seen.add(card.type);
    const p = statutoryProblem(card, saleDay);
    if (p) return several ? `${label} card: ${p}` : p;
    if (!state.lines.some((l) => lineStatutoryType(state, l) === card.type)) {
      return several ? `No item gets the ${label} discount — choose its items or remove the card.` : `None of these items is eligible for the ${label} discount.`;
    }
  }
  const sp = cards.find((c) => c.type === 'SOLO_PARENT');
  if (sp && !sp.rxInChildName && state.lines.some((l) => l.rxRequired && lineStatutoryType(state, l) === 'SOLO_PARENT')) {
    return 'A prescription item gets the Solo Parent discount only when the prescription is in the child’s name — confirm it.';
  }
  return null;
}

/** A card as the payload carries it — with the rate / VAT charged for its type when the server sent the rules (an older
 * server: exactly as before). */
export function cardPayload(state: Pick<CartState, 'statutoryConfig'>, card: StatutoryDraft) {
  return statutoryPayload(card, state.statutoryConfig.known ? state.statutoryConfig.rules[card.type] : null);
}

/**
 * The payload's statutory fields (contract §2b): one card → the single `statutory_discount` (every eligible line gets it,
 * lines carry no statutory_type); several → `statutory_cards` in order (card 0 = the sale client's) and each line names its
 * card (`lineStatutoryType`, added by checkout).
 */
export function statutoryPayloadFields(state: Pick<CartState, 'statutory' | 'extraCards' | 'statutoryConfig'>): Pick<SalePayload, 'statutory_discount' | 'statutory_cards'> {
  if (!state.statutory) return { statutory_discount: null };
  if (!multiCard(state)) return { statutory_discount: cardPayload(state, state.statutory) };
  return { statutory_discount: null, statutory_cards: saleCards(state).map((c) => cardPayload(state, c)) };
}
