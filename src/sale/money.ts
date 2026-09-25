// Money helpers for the selling screens. Amounts are JS numbers rounded to centavos while the cashier works; the
// SalePayload carries them as 2-decimal strings (contract: "Money is a Decimal-serialized string").

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const toCents = (n: number) => Math.round(n * 100);

/** "123.45" — what goes into the payload. */
export function money(n: number): string {
  const v = round2(n);
  return (Object.is(v, -0) ? 0 : v).toFixed(2);
}

const peso = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₱1,234.50" for the screen. */
export function formatPeso(n: number | string): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '₱0.00';
  const abs = peso.format(Math.abs(round2(v)));
  return round2(v) < 0 ? `-₱${abs}` : `₱${abs}`;
}

const TWO_DECIMALS = /^\d+(\.\d{1,2})?$/;

/** True for "12", "12.5", "12.50" (no sign, at most 2 decimals). */
export function isMoneyText(s: string): boolean {
  return TWO_DECIMALS.test(s.trim());
}

/** Parses what the cashier typed; blank or junk → 0. */
export function parseAmount(s: string): number {
  const n = Number(s.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Keeps a numeric text field to digits and one dot (decimal-pad keyboards can still paste junk). */
export function cleanDecimalInput(s: string): string {
  const cleaned = s.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  return dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}
