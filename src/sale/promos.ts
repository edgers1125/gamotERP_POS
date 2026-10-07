// Store promos on the till (GamotERP docs/plans/labels-promos-recommendations.md "As built — Part A promos" + "POS app
// work"; contract `PosPromo`). Pure — no React / Expo imports (scripts/promo-selftest.ts runs it under Node).
//
// * The promos come from the cached bootstrap (`promos`, published + not ended, scheduled ones included) so they start
//   and stop on time OFFLINE. An older server doesn't send the field → no promos.
// * THE price rule is the backend's `@shared/promos/promo-math` (integer centavos, half-up; in force
//   starts_at ≤ t < ends_at; two in force on one SKU → the lower price) — never re-implemented here.
// * The clock: a promo is judged at the moment the sale is recorded, on the DEVICE clock — the same instant that goes out
//   as `sold_at` (checkout.ts), because the server checks the line against the promo in force at `sold_at`. Like every
//   other sale time it is not corrected by the server-clock offset (src/device/serverClock.ts: DPoP only); a tablet whose
//   clock is off is flagged CLOCK_DRIFT by the server, and a promo charged outside its window PRICE_MISMATCH (recorded as
//   charged, never rejected).
// * A cart line keeps its REGULAR channel price (`unitPrice` / `unitPriceText`) and carries the promo that applies
//   (`promo`) + on a Senior/PWD sale the cashier's choice (`promoChoice`); what is charged is derived (`chargedLine`).
import {
  compareScPwd,
  describePromoTerms,
  promoCents,
  promoFor,
  promoUnitPriceCents,
  type PromoScPwdChoice,
  type PromoScPwdComparison,
} from '@shared/promos/promo-math';
import { canonicalJson, type PosBootstrap, type PosPromo, type SaleLinePayload } from '@pos-api/contract';

export type { PromoScPwdChoice, PromoScPwdComparison } from '@shared/promos/promo-math';

/** The promo pricing a cart line (frozen until the next re-check). */
export interface LinePromo {
  id: number;
  name: string;
  /** Promo unit price, "85.00" (sent as unit_price when charged). */
  priceText: string;
  price: number;
  /** "15% off" / "₱20.00 off" / "₱99.00 promo price". */
  terms: string;
  /** ISO, exclusive — shown as "until …". */
  endsAt: string;
}

/** The fields of a cart line this module reads/writes (structural, so it doesn't import the zustand cart). */
export interface PromoLine {
  skuId: number;
  name: string;
  quantity: number;
  /** The REGULAR channel price, exactly as the catalog has it. */
  unitPriceText: string;
  unitPrice: number;
  scPwdEligible: boolean;
  promo: LinePromo | null;
  /** Senior/PWD sale + promo line: the cashier's choice; null = not chosen (no default — decision 6). */
  promoChoice: PromoScPwdChoice | null;
}

const DISCOUNT_TYPES = new Set(['PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_PRICE']);

function validPromo(p: unknown): p is PosPromo {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id <= 0) return false;
  if (typeof o.name !== 'string' || !DISCOUNT_TYPES.has(o.discount_type as string)) return false;
  if (typeof o.discount_value !== 'string' && typeof o.discount_value !== 'number') return false;
  try {
    if (promoCents(o.discount_value as string) <= 0) return false;
  } catch {
    return false;
  }
  if (typeof o.starts_at !== 'string' || typeof o.ends_at !== 'string') return false;
  if (!Number.isFinite(Date.parse(o.starts_at)) || !Number.isFinite(Date.parse(o.ends_at))) return false;
  return Array.isArray(o.sku_ids) && o.sku_ids.every((s) => typeof s === 'number');
}

/** The cached bootstrap's promos, read defensively (an older server sends none; a malformed entry is skipped). */
export function promosOf(bootstrap: Pick<PosBootstrap, 'promos'> | null | undefined): PosPromo[] {
  const list = (bootstrap as { promos?: unknown } | null | undefined)?.promos;
  return Array.isArray(list) ? list.filter(validPromo) : [];
}

/**
 * Same promo list (deep, key order ignored)? A bootstrap re-read (every heartbeat while the real-time channel is down)
 * yields a NEW array of the same promos; the cart ignores it then (`setPromos` is a no-op), so a background refresh never
 * looks like a cart change — that would restart the till's idle timer (src/auth/tillLock.ts).
 */
export function samePromoList(a: readonly PosPromo[], b: readonly PosPromo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((p, i) => p === b[i] || canonicalJson(p) === canonicalJson(b[i]));
}

/** The promo that prices `skuId` at `at` off `regularPriceText` — null when none is in force or it wouldn't lower it. */
export function linePromoAt(promos: readonly PosPromo[], skuId: number, regularPriceText: string, at: Date): LinePromo | null {
  if (promos.length === 0) return null;
  try {
    const p = promoFor(promos, skuId, at, regularPriceText);
    if (!p) return null;
    const base = promoCents(regularPriceText);
    const cents = promoUnitPriceCents(base, p);
    if (cents >= base) return null; // doesn't lower the price → the promo simply doesn't apply (server: applyPromo null)
    return { id: p.id, name: p.name, priceText: (cents / 100).toFixed(2), price: cents / 100, terms: describePromoTerms(p), endsAt: p.ends_at };
  } catch {
    return null;
  }
}

function samePromo(a: LinePromo | null, b: LinePromo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.priceText === b.priceText && a.name === b.name;
}

/** A line with its promo for `at` (the same object when nothing changed). A different promo clears the SC/PWD choice. */
export function withPromoAt<L extends PromoLine>(line: L, promos: readonly PosPromo[], at: Date): L {
  const next = linePromoAt(promos, line.skuId, line.unitPriceText, at);
  if (samePromo(line.promo, next)) return line;
  const keepChoice = next !== null && line.promo !== null && line.promo.id === next.id && line.promo.priceText === next.priceText;
  return { ...line, promo: next, promoChoice: keepChoice ? line.promoChoice : null };
}

export interface PromoRefresh<L> {
  lines: L[];
  changed: boolean;
  /** Promo names that now price a line (started / newly applied). */
  started: string[];
  /** Promo names that no longer price a line (ended / cancelled). */
  ended: string[];
}

/** Re-checks every line's promo at `at` (cart open while a promo starts or ends, a new bootstrap, payment). */
export function refreshLinePromos<L extends PromoLine>(lines: readonly L[], promos: readonly PosPromo[], at: Date): PromoRefresh<L> {
  const started = new Set<string>();
  const ended = new Set<string>();
  let changed = false;
  const next = lines.map((l) => {
    const n = withPromoAt(l, promos, at);
    if (n !== l) {
      changed = true;
      if (l.promo && (!n.promo || n.promo.id !== l.promo.id)) ended.add(l.promo.name);
      if (n.promo && (!l.promo || n.promo.id !== l.promo.id)) started.add(n.promo.name);
      if (l.promo && n.promo && l.promo.id === n.promo.id) started.add(n.promo.name); // same promo, new price
    }
    return n;
  });
  return { lines: next, changed, started: [...started], ended: [...ended] };
}

/** One sentence for the cart notice, or null when nothing changed. */
export function promoRefreshNotice(r: PromoRefresh<unknown>): string | null {
  if (!r.changed) return null;
  const parts: string[] = [];
  if (r.started.length > 0) parts.push(`Promo now applied: ${r.started.join(', ')}.`);
  if (r.ended.length > 0) parts.push(`Promo ended: ${r.ended.join(', ')} — back to the regular price.`);
  if (parts.length === 0) parts.push('Promo prices were updated.');
  return parts.join(' ');
}

/** A promo line on a Senior/PWD sale of an eligible item: the cashier must choose PROMO or SCPWD. */
export function needsPromoChoice(line: PromoLine, statutoryLine: boolean): boolean {
  return statutoryLine && line.promo !== null;
}

export interface ChargedLine {
  /** What the line is charged per unit (unit_price). */
  unitPrice: number;
  unitPriceText: string;
  /** The regular price is struck through (the promo price is charged). */
  promoApplied: boolean;
  /** Statutory rate for the shared pricing code — 0 on a PROMO choice (VAT-exempt, no 20 %); undefined = the default 20 %. */
  statutoryDiscountRate?: number;
}

/**
 * What a line is charged: no promo → regular; promo on a non-statutory line → promo price; statutory line → PROMO =
 * promo price with no 20 % (still VAT-exempt), SCPWD = regular + 20 %; not chosen yet → regular + 20 % (provisional —
 * the sale can't be charged until the cashier chooses, `promoChoiceProblem`).
 */
export function chargedLine(line: PromoLine, statutoryLine: boolean): ChargedLine {
  const regular: ChargedLine = { unitPrice: line.unitPrice, unitPriceText: line.unitPriceText, promoApplied: false };
  if (!line.promo) return regular;
  const promo: ChargedLine = { unitPrice: line.promo.price, unitPriceText: line.promo.priceText, promoApplied: true };
  if (!statutoryLine) return promo;
  if (line.promoChoice === 'PROMO') return { ...promo, statutoryDiscountRate: 0 };
  return regular;
}

/** Both amounts for the cashier's choice (shared compareScPwd — highlight `better`). */
export function scPwdComparison(line: PromoLine): PromoScPwdComparison | null {
  if (!line.promo) return null;
  return compareScPwd(line.quantity, line.unitPriceText, line.promo.priceText);
}

export const PROMO_LAW_NOTE = 'By law the customer gets the better of the two — the promo or the Senior/PWD 20% — never both.';

/** The first line still waiting for the cashier's Promo-vs-SC/PWD choice (null = none). */
export function promoChoiceProblem(lines: readonly PromoLine[], isStatutory: (l: PromoLine) => boolean): string | null {
  const open = lines.filter((l) => needsPromoChoice(l, isStatutory(l)) && l.promoChoice === null);
  if (open.length === 0) return null;
  return open.length === 1
    ? `Choose Promo or Senior/PWD 20% for ${open[0]!.name}.`
    : `Choose Promo or Senior/PWD 20% for ${open.length} items (${open.map((l) => l.name).join(', ')}).`;
}

/** The promo fields of the sale line (contract SaleLinePayload) — none for a line without a promo (older servers too). */
export function promoPayloadFields(line: PromoLine, statutoryLine: boolean): Pick<SaleLinePayload, 'promo_id' | 'regular_unit_price' | 'promo_vs_scpwd'> {
  if (!line.promo) return {};
  return {
    promo_id: line.promo.id,
    regular_unit_price: line.unitPriceText,
    promo_vs_scpwd: statutoryLine ? line.promoChoice : null,
  };
}

/** Every line's promo matches what's in force at `at` (checkout's last guard before the sale is recorded). */
export function promosCurrentAt(lines: readonly PromoLine[], promos: readonly PosPromo[], at: Date): boolean {
  return lines.every((l) => samePromo(l.promo, linePromoAt(promos, l.skuId, l.unitPriceText, at)));
}
