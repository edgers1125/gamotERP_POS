// The cart being rung up (zustand `useCart`), shared by the Sell and Payment screens. Prices are the chosen pricing
// channel's (`item.prices[channelId]`, from the cached catalog) and are captured on each line when added — the
// payload sends them "as charged" together with the catalog_version they came from.
// Store promos (src/sale/promos.ts): the cart holds the bootstrap's promos (`setPromos`); each line keeps its REGULAR
// price and the promo in force when it was added / last re-checked (`refreshPromos` — a timer on the Sell screen, a new
// bootstrap, and the moment of payment). What a line is charged = `chargedLine` (promo price, or on a Senior/PWD sale
// the cashier's Promo-vs-SC/PWD choice).
import { create } from 'zustand';
import * as Crypto from 'expo-crypto';
import { isPhMobile, normalizePhone } from '@shared/phone';
import type { PosCatalog, PosCatalogItem, PosClient, PosPromo } from '@pos-api/contract';
import { computeCartTotals, discountInput, hasDiscount, NO_DISCOUNT, type DiscountDraft, type SaleTotals } from './totals';
import { isMoneyText, round2 } from './money';
import { statutoryClientConflict, statutoryProblem, type StatutoryDraft } from './statutory';
import {
  chargedLine,
  promoChoiceProblem,
  promoRefreshNotice,
  refreshLinePromos,
  samePromoList,
  withPromoAt,
  type ChargedLine,
  type LinePromo,
  type PromoScPwdChoice,
} from './promos';

export interface CartLine {
  skuId: number;
  skuCode: string;
  name: string;
  packQuantity: number;
  /** The REGULAR channel price exactly as the catalog has it (sent as unit_price unless a promo prices the line, then
   * as regular_unit_price). What's charged: `chargedLineOf`. */
  unitPriceText: string;
  unitPrice: number;
  isVatable: boolean;
  scPwdEligible: boolean;
  quantity: number;
  discount: DiscountDraft;
  /** The store promo pricing this line (null = none). */
  promo: LinePromo | null;
  /** Senior/PWD sale + promo line: the cashier's choice (null = not chosen — no default). */
  promoChoice: PromoScPwdChoice | null;
}

// Like the web's Branch Sales, the client is REQUIRED: a new sale starts UNSET and can't be charged until the cashier
// picks an existing client, registers a new one (name + phone), or taps "No client details" (WALK_IN — the web's
// "Client prefers not to give contact details": names optional, no contact details).
export type SaleClient =
  | { kind: 'UNSET' }
  | { kind: 'WALK_IN'; clientUuid: string; firstName: string; lastName: string }
  | { kind: 'EXISTING'; client: PosClient }
  // Created on the device (merged on sync by client_uuid). First + last name and phone are required when the cashier
  // registers them; a cardholder added from the Senior/PWD dialog has phone '' (the card identifies them).
  | { kind: 'NEW'; clientUuid: string; firstName: string; middleName: string; lastName: string; phone: string };

/** Why a new client can't be registered yet (null = ready). The server needs first + last name and phone (judged in
 * its canonical form, `@shared/phone` — the form it's stored and sent in). */
export function newClientProblem(c: { firstName: string; lastName: string; phone: string }): string | null {
  if (c.firstName.trim() === '' || c.lastName.trim() === '') return 'Enter the client’s first and last name.';
  const phone = normalizePhone(c.phone);
  if (phone === '') return 'Enter the client’s phone number.';
  if (phone.length > 30) return 'The phone number must be 30 characters or fewer.';
  return null;
}

/** A stored (canonical) phone for reading on screen: a PH mobile grouped "0917 653 0117", anything else as stored.
 * Display only — never stored or sent. */
export function displayPhone(stored: string): string {
  const canonical = normalizePhone(stored);
  return isPhMobile(canonical) ? `${canonical.slice(0, 4)} ${canonical.slice(4, 7)} ${canonical.slice(7)}` : stored;
}

export interface CartState {
  channelId: number | null;
  /** catalog.version the line prices were taken from (null while the cart is empty). */
  catalogVersion: string | null;
  lines: CartLine[];
  txDiscount: DiscountDraft;
  txDiscountReason: string;
  statutory: StatutoryDraft | null;
  client: SaleClient;
  soldById: number | null;
  note: string;
  /** One-off message for the cashier (re-pricing, dropped items). */
  notice: string | null;
  /** Unexpired on-shelf stock per SKU (online hint only — a short sale is recorded OVERSOLD, never refused). */
  stock: Record<number, number>;
  /** The terminal's store promos (cached bootstrap `promos`; [] from an older server). Kept across sales. */
  promos: PosPromo[];

  setChannel(channelId: number, catalog: PosCatalog | null, channelName?: string): void;
  /** Adds one unit; returns an error message when the item can't be sold at the channel. */
  addItem(item: PosCatalogItem, catalogVersion: string | null): string | null;
  setQuantity(skuId: number, quantity: number): void;
  setLineDiscount(skuId: number, discount: DiscountDraft): void;
  removeLine(skuId: number): void;
  setTxDiscount(discount: DiscountDraft, reason: string): void;
  setStatutory(draft: StatutoryDraft | null): void;
  setClient(client: SaleClient): void;
  setSoldBy(userId: number | null): void;
  setNote(note: string): void;
  setNotice(notice: string | null): void;
  setStock(stock: Record<number, number>): void;
  /** Re-prices the cart from a newer catalog (drops lines no longer priced at the channel). */
  applyCatalog(catalog: PosCatalog): void;
  /** New promos from the bootstrap — re-checks the lines at `at`. */
  setPromos(promos: PosPromo[], at?: Date): void;
  /** Re-checks every line's promo at `at`; a change sets the notice. Returns that notice (null = nothing changed). */
  refreshPromos(at?: Date): string | null;
  /** The cashier's Promo-vs-SC/PWD choice on a line. */
  setPromoChoice(skuId: number, choice: PromoScPwdChoice | null): void;
  /** Starts a new sale; keeps the channel and Sold By. */
  reset(): void;
}

export function priceAt(item: PosCatalogItem, channelId: number | null): string | null {
  if (channelId === null) return null;
  const p = item.prices[String(channelId)];
  return p !== undefined && p !== null && p !== '' && Number.isFinite(Number(p)) ? p : null;
}

function repriced(lines: CartLine[], catalog: PosCatalog | null, channelId: number, promos: readonly PosPromo[]) {
  const byId = new Map((catalog?.items ?? []).map((i) => [i.sku_id, i]));
  const kept: CartLine[] = [];
  const dropped: string[] = [];
  let changed = 0;
  for (const l of lines) {
    const item = byId.get(l.skuId);
    const price = item ? priceAt(item, channelId) : null;
    if (!item || price === null) {
      dropped.push(l.name);
      continue;
    }
    if (Number(price) !== l.unitPrice) changed += 1;
    // The promo is re-taken off the new regular price (a % / ₱ off follows it; a fixed price is capped at it).
    kept.push(
      withPromoAt(
        {
          ...l,
          name: item.final_name,
          skuCode: item.sku_code,
          packQuantity: item.pack_quantity,
          unitPriceText: price,
          unitPrice: Number(price),
          isVatable: item.is_vatable,
          scPwdEligible: item.sc_pwd_eligible,
        },
        promos,
        new Date(),
      ),
    );
  }
  return { kept, dropped, changed };
}

const EMPTY = {
  catalogVersion: null,
  lines: [] as CartLine[],
  txDiscount: NO_DISCOUNT,
  txDiscountReason: '',
  statutory: null,
  client: { kind: 'UNSET' } as SaleClient,
  note: '',
  notice: null,
  stock: {} as Record<number, number>,
};

// Changes the app makes by itself (promo re-checks, a newer price list) — not a person at the till. The till's idle timer
// (src/auth/tillLock.ts) ignores them: zustand calls subscribers synchronously inside set(), so they can ask.
let systemDepth = 0;
function systemUpdate(fn: () => void): void {
  systemDepth += 1;
  try {
    fn();
  } finally {
    systemDepth -= 1;
  }
}
/** True while the cart is being changed by the app itself (inside a subscriber call), not by the cashier. */
export function isSystemCartUpdate(): boolean {
  return systemDepth > 0;
}

export const useCart = create<CartState>()((set, get) => ({
  channelId: null,
  soldById: null,
  promos: [],
  ...EMPTY,

  setChannel(channelId, catalog, channelName) {
    const s = get();
    if (s.channelId === channelId) return;
    if (s.lines.length === 0) {
      set({ channelId, notice: null });
      return;
    }
    const { kept, dropped, changed } = repriced(s.lines, catalog, channelId, s.promos);
    const name = channelName ?? 'the new channel';
    const parts = [changed > 0 ? `Prices changed to ${name}: ${changed} item${changed === 1 ? '' : 's'} re-priced.` : `Prices are now ${name}’s — no price changed.`];
    if (dropped.length > 0) parts.push(`Removed (no price at this channel): ${dropped.join(', ')}.`);
    set({ channelId, lines: kept, catalogVersion: kept.length > 0 ? (catalog?.version ?? s.catalogVersion) : null, notice: parts.join(' ') });
  },

  addItem(item, catalogVersion) {
    const s = get();
    const price = priceAt(item, s.channelId);
    if (price === null) return `“${item.final_name}” has no price at this pricing channel, so it can’t be sold here.`;
    const existing = s.lines.find((l) => l.skuId === item.sku_id);
    if (existing) {
      const now = new Date();
      set({ lines: s.lines.map((l) => (l.skuId === item.sku_id ? withPromoAt({ ...l, quantity: l.quantity + 1 }, s.promos, now) : l)) });
      return null;
    }
    // The promo in force NOW (device clock — the same clock sold_at is taken from) prices the new line.
    const line: CartLine = withPromoAt<CartLine>({
      skuId: item.sku_id,
      skuCode: item.sku_code,
      name: item.final_name,
      packQuantity: item.pack_quantity,
      unitPriceText: price,
      unitPrice: Number(price),
      isVatable: item.is_vatable,
      scPwdEligible: item.sc_pwd_eligible,
      quantity: 1,
      discount: NO_DISCOUNT,
      promo: null,
      promoChoice: null,
    }, s.promos, new Date());
    set({ lines: [...s.lines, line], catalogVersion: s.catalogVersion ?? catalogVersion });
    return null;
  },

  setQuantity(skuId, quantity) {
    const q = Math.max(1, Math.min(99999, Math.floor(quantity) || 1));
    set({ lines: get().lines.map((l) => (l.skuId === skuId ? { ...l, quantity: q } : l)) });
  },

  setLineDiscount(skuId, discount) {
    set({ lines: get().lines.map((l) => (l.skuId === skuId ? { ...l, discount } : l)) });
  },

  removeLine(skuId) {
    const lines = get().lines.filter((l) => l.skuId !== skuId);
    set({ lines, ...(lines.length === 0 ? { catalogVersion: null } : {}) });
  },

  setTxDiscount(discount, reason) {
    set({ txDiscount: discount, txDiscountReason: reason });
  },

  // Turning Senior/PWD on clears what it can't be combined with (no double discount), rather than leaving values that
  // would be refused.
  setStatutory(draft) {
    const s = get();
    if (draft && !s.statutory) {
      set({
        statutory: draft,
        lines: s.lines.map((l) => (l.scPwdEligible ? { ...l, discount: NO_DISCOUNT } : l)),
        txDiscount: NO_DISCOUNT,
        txDiscountReason: '',
      });
      return;
    }
    set({ statutory: draft });
  },

  setClient(client) {
    set({ client });
  },
  setSoldBy(userId) {
    set({ soldById: userId });
  },
  setNote(note) {
    set({ note });
  },
  setNotice(notice) {
    set({ notice });
  },
  setStock(stock) {
    systemUpdate(() => set({ stock }));
  },

  applyCatalog(catalog) {
    const s = get();
    if (s.lines.length === 0) {
      if (s.catalogVersion !== null) systemUpdate(() => set({ catalogVersion: null }));
      return;
    }
    if (s.catalogVersion === catalog.version || s.channelId === null) return;
    const { kept, dropped, changed } = repriced(s.lines, catalog, s.channelId, s.promos);
    const parts = ['The price list was updated.'];
    if (changed > 0) parts.push(`${changed} item${changed === 1 ? '' : 's'} re-priced.`);
    if (dropped.length > 0) parts.push(`Removed (no longer priced here): ${dropped.join(', ')}.`);
    systemUpdate(() =>
      set({ lines: kept, catalogVersion: kept.length > 0 ? catalog.version : null, notice: changed > 0 || dropped.length > 0 ? parts.join(' ') : s.notice }),
    );
  },

  setPromos(promos, at = new Date()) {
    // The same promos re-read (every bootstrap refresh builds a new array) → nothing to do: no state change, so no
    // subscriber (the till's idle timer) sees one. Promos starting / ending on time are the Sell screen's tick.
    if (samePromoList(get().promos, promos)) return;
    systemUpdate(() => {
      set({ promos });
      get().refreshPromos(at);
    });
  },

  refreshPromos(at = new Date()) {
    const s = get();
    if (s.lines.length === 0) return null;
    const r = refreshLinePromos(s.lines, s.promos, at);
    const notice = promoRefreshNotice(r);
    if (r.changed) systemUpdate(() => set({ lines: r.lines, notice: notice ?? s.notice }));
    return notice;
  },

  setPromoChoice(skuId, choice) {
    set({ lines: get().lines.map((l) => (l.skuId === skuId && l.promo ? { ...l, promoChoice: choice } : l)) });
  },

  reset() {
    set({ ...EMPTY });
  },
}));

// ---------------------------------------------------------------------------------------------------------------
// Derived values (pure — call from components with useMemo).

export function isStatutoryLine(state: Pick<CartState, 'statutory'>, line: CartLine): boolean {
  return state.statutory !== null && line.scPwdEligible;
}

/** What the line is charged (promo price, or the regular price; a Senior/PWD promo line by the cashier's choice). */
export function chargedLineOf(state: Pick<CartState, 'statutory'>, line: CartLine): ChargedLine {
  return chargedLine(line, isStatutoryLine(state, line));
}

export function cartTotals(state: Pick<CartState, 'lines' | 'txDiscount' | 'statutory'>): SaleTotals {
  return computeCartTotals(
    state.lines.map((l) => {
      const charged = chargedLineOf(state, l);
      return {
        quantity: l.quantity,
        unitPrice: charged.unitPrice,
        isVatable: l.isVatable,
        isStatutory: isStatutoryLine(state, l),
        ...(charged.statutoryDiscountRate !== undefined ? { statutoryDiscountRate: charged.statutoryDiscountRate } : {}),
        itemDiscount: l.discount,
      };
    }),
    state.txDiscount,
    state.statutory !== null,
  );
}

/** A discount a person chose (item or transaction) → the co-sign is required. The statutory 20% never needs one. */
export function discountNeedsApproval(totals: SaleTotals): boolean {
  return round2(totals.totalItemDiscount + totals.transactionDiscountAmount) > 0;
}

function discountTextProblem(d: DiscountDraft): string | null {
  if (d.value.trim() === '') return null;
  if (!isMoneyText(d.value)) return 'Use a number with at most 2 decimal places for the discount.';
  if (d.mode === 'percent' && Number(d.value) > 100) return 'A percentage discount can’t be more than 100%.';
  return null;
}

/** The first discount problem the server would refuse (null = fine). */
export function discountProblem(state: Pick<CartState, 'lines' | 'txDiscount' | 'txDiscountReason' | 'statutory'>, totals: SaleTotals): string | null {
  for (let i = 0; i < state.lines.length; i++) {
    const l = state.lines[i]!;
    if (isStatutoryLine(state, l)) {
      if (hasDiscount(l.discount)) return `${l.name} already gets the Senior/PWD discount — remove the item discount.`;
      continue;
    }
    const p = discountTextProblem(l.discount);
    if (p) return `${l.name}: ${p}`;
    if ((totals.itemDiscountAmounts[i] ?? 0) > round2(l.quantity * chargedLineOf(state, l).unitPrice)) return `${l.name}: the discount can’t exceed the line subtotal.`;
  }
  if (state.statutory !== null && hasDiscount(state.txDiscount)) return 'A transaction discount can’t be combined with the Senior/PWD discount.';
  const tp = discountTextProblem(state.txDiscount);
  if (tp) return `Transaction discount: ${tp}`;
  if (hasDiscount(state.txDiscount)) {
    const postItem = round2(totals.subtotal - totals.totalItemDiscount);
    if (totals.transactionDiscountAmount > postItem) return 'The transaction discount can’t exceed the subtotal.';
    if (state.txDiscountReason.trim() === '') return 'Enter the reason for the transaction discount.';
  }
  return null;
}

/** Why the cart can't go to payment yet (null = ready). */
export function cartProblem(state: CartState, totals: SaleTotals): string | null {
  if (state.channelId === null) return 'Choose the pricing channel.';
  if (state.lines.length === 0) return 'Add at least one item.';
  if (state.soldById === null) return 'Choose who sold it (Sold By).';
  if (state.client.kind === 'UNSET' && !state.statutory) return 'Add the client — or tap “No client details”.';
  const d = discountProblem(state, totals);
  if (d) return d;
  if (state.statutory) {
    if (!state.lines.some((l) => l.scPwdEligible)) return 'No item in the cart is eligible for the Senior/PWD discount.';
    const p = statutoryProblem(state.statutory);
    if (p) return p;
    // A promo item on a Senior/PWD sale: the cashier picks the promo OR the 20 % per line (decision 6) — no default.
    const choice = promoChoiceProblem(state.lines, (l) => isStatutoryLine(state, l as CartLine));
    if (choice) return choice;
    if (state.client.kind === 'WALK_IN' || state.client.kind === 'UNSET') return 'A Senior/PWD sale needs the cardholder as the client.';
    if (state.client.kind === 'EXISTING') {
      const c = statutoryClientConflict(state.statutory, state.client.client);
      if (c) return c;
    }
  } else if (state.client.kind === 'NEW') {
    const c = newClientProblem(state.client);
    if (c) return c;
  }
  if (state.note.trim().length > 500) return 'The note must be 500 characters or fewer.';
  return null;
}

export function newClientUuid(): string {
  return Crypto.randomUUID();
}

/** Unused-safe helper for the discount chips: "10%" or "₱5.00". */
export function discountLabel(d: DiscountDraft): string {
  const i = discountInput(d);
  if (i.percent != null) return `${i.percent}%`;
  return `₱${i.amount.toFixed(2)}`;
}
