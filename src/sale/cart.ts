// The cart being rung up (zustand `useCart`), shared by the Sell and Payment screens. Prices are the chosen pricing
// channel's (`item.prices[channelId]`, from the cached catalog) and are captured on each line when added — the
// payload sends them "as charged" together with the catalog_version they came from.
import { create } from 'zustand';
import * as Crypto from 'expo-crypto';
import type { PosCatalog, PosCatalogItem, PosClient } from '@pos-api/contract';
import { computeCartTotals, discountInput, hasDiscount, NO_DISCOUNT, type DiscountDraft, type SaleTotals } from './totals';
import { isMoneyText, round2 } from './money';
import { statutoryClientConflict, statutoryProblem, type StatutoryDraft } from './statutory';

export interface CartLine {
  skuId: number;
  skuCode: string;
  name: string;
  packQuantity: number;
  /** The channel price exactly as the catalog has it (sent as unit_price). */
  unitPriceText: string;
  unitPrice: number;
  isVatable: boolean;
  scPwdEligible: boolean;
  quantity: number;
  discount: DiscountDraft;
}

export type SaleClient =
  | { kind: 'WALK_IN' }
  | { kind: 'EXISTING'; client: PosClient }
  // Created on the device (merged on sync by client_uuid). Named, no contact details — the POS doesn't collect them.
  | { kind: 'NEW'; clientUuid: string; firstName: string; middleName: string; lastName: string };

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
  /** Starts a new sale; keeps the channel and Sold By. */
  reset(): void;
}

export function priceAt(item: PosCatalogItem, channelId: number | null): string | null {
  if (channelId === null) return null;
  const p = item.prices[String(channelId)];
  return p !== undefined && p !== null && p !== '' && Number.isFinite(Number(p)) ? p : null;
}

function repriced(lines: CartLine[], catalog: PosCatalog | null, channelId: number) {
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
    kept.push({
      ...l,
      name: item.final_name,
      skuCode: item.sku_code,
      packQuantity: item.pack_quantity,
      unitPriceText: price,
      unitPrice: Number(price),
      isVatable: item.is_vatable,
      scPwdEligible: item.sc_pwd_eligible,
    });
  }
  return { kept, dropped, changed };
}

const EMPTY = {
  catalogVersion: null,
  lines: [] as CartLine[],
  txDiscount: NO_DISCOUNT,
  txDiscountReason: '',
  statutory: null,
  client: { kind: 'WALK_IN' } as SaleClient,
  note: '',
  notice: null,
  stock: {} as Record<number, number>,
};

export const useCart = create<CartState>()((set, get) => ({
  channelId: null,
  soldById: null,
  ...EMPTY,

  setChannel(channelId, catalog, channelName) {
    const s = get();
    if (s.channelId === channelId) return;
    if (s.lines.length === 0) {
      set({ channelId, notice: null });
      return;
    }
    const { kept, dropped, changed } = repriced(s.lines, catalog, channelId);
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
      set({ lines: s.lines.map((l) => (l.skuId === item.sku_id ? { ...l, quantity: l.quantity + 1 } : l)) });
      return null;
    }
    const line: CartLine = {
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
    };
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
    set({ stock });
  },

  applyCatalog(catalog) {
    const s = get();
    if (s.lines.length === 0) {
      if (s.catalogVersion !== null) set({ catalogVersion: null });
      return;
    }
    if (s.catalogVersion === catalog.version || s.channelId === null) return;
    const { kept, dropped, changed } = repriced(s.lines, catalog, s.channelId);
    const parts = ['The price list was updated.'];
    if (changed > 0) parts.push(`${changed} item${changed === 1 ? '' : 's'} re-priced.`);
    if (dropped.length > 0) parts.push(`Removed (no longer priced here): ${dropped.join(', ')}.`);
    set({ lines: kept, catalogVersion: kept.length > 0 ? catalog.version : null, notice: changed > 0 || dropped.length > 0 ? parts.join(' ') : s.notice });
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

export function cartTotals(state: Pick<CartState, 'lines' | 'txDiscount' | 'statutory'>): SaleTotals {
  return computeCartTotals(
    state.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      isVatable: l.isVatable,
      isStatutory: isStatutoryLine(state, l),
      itemDiscount: l.discount,
    })),
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
    if ((totals.itemDiscountAmounts[i] ?? 0) > round2(l.quantity * l.unitPrice)) return `${l.name}: the discount can’t exceed the line subtotal.`;
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
  const d = discountProblem(state, totals);
  if (d) return d;
  if (state.statutory) {
    if (!state.lines.some((l) => l.scPwdEligible)) return 'No item in the cart is eligible for the Senior/PWD discount.';
    const p = statutoryProblem(state.statutory);
    if (p) return p;
    if (state.client.kind === 'WALK_IN') return 'A Senior/PWD sale needs the cardholder as the client.';
    if (state.client.kind === 'EXISTING') {
      const c = statutoryClientConflict(state.statutory, state.client.client);
      if (c) return c;
    }
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
