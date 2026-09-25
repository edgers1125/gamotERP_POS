// Split tender within ONE pricing channel — the same per-line rules the server applies (pos-terminals-payments-scpwd.md
// "B2 as built"), so Complete Sale stays disabled until the tender is valid: amounts > 0 with ≤ 2 decimals, a reference
// where the method requires one (≤ 64), cash received required for the (single) cash line and ≥ its amount, and the
// lines adding up to the grand total to the centavo. A zero-total sale takes no payment.
import type { PosPaymentMethod, SalePaymentPayload } from '@pos-api/contract';
import { isMoneyText, money, round2, toCents } from './money';

export interface PaymentDraft {
  key: number;
  methodId: number;
  amount: string;
  reference: string;
  tendered: string;
  /** Follows the remaining balance until the cashier types an amount of their own. */
  auto: boolean;
}

let nextKey = 1;
export function newPaymentLine(methodId: number, amount: number, auto: boolean): PaymentDraft {
  return { key: nextKey++, methodId, amount: amount > 0 ? amount.toFixed(2) : '', reference: '', tendered: '', auto };
}

/** The auto line absorbs whatever the other lines leave of the grand total. */
export function syncAutoLine(lines: PaymentDraft[], grandTotal: number): PaymentDraft[] {
  const auto = lines.find((l) => l.auto);
  if (!auto) return lines;
  const others = lines.filter((l) => l !== auto).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const amount = Math.max(round2(grandTotal - others), 0).toFixed(2);
  return amount === auto.amount ? lines : lines.map((l) => (l === auto ? { ...l, amount } : l));
}

/** Quick "cash received" amounts: exact, then the next ₱50 / ₱100 / ₱500 / ₱1000 above it (distinct). */
export function quickTenders(amount: number): number[] {
  const exact = round2(amount);
  const out = [exact];
  for (const step of [50, 100, 500, 1000]) {
    const v = Math.ceil(exact / step) * step;
    const next = v === exact ? v + step : v;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

export function lineError(line: PaymentDraft, method: PosPaymentMethod | undefined): string | null {
  if (!method) return 'This method is not accepted on this POS';
  const amount = Number(line.amount);
  if (line.amount.trim() === '' || !(amount > 0)) return 'Enter an amount greater than zero';
  if (!isMoneyText(line.amount)) return 'Use at most 2 decimal places';
  if (method.requires_reference && line.reference.trim() === '') return `Enter the reference number for ${method.name}`;
  if (line.reference.trim().length > 64) return 'The reference number must be 64 characters or fewer';
  if (method.kind === 'CASH') {
    if (line.tendered.trim() === '') return 'Enter the cash received';
    if (!isMoneyText(line.tendered)) return 'Use at most 2 decimal places for the cash received';
    if (!(Number(line.tendered) >= amount)) return 'The cash received must be at least the amount';
  }
  return null;
}

export interface PaymentsState {
  errors: (string | null)[];
  remaining: number;
  valid: boolean;
  cashLines: number;
  /** Change for the cash line (tendered − amount), null when there's none / not yet valid. */
  change: number | null;
  problem: string | null;
}

export function paymentsState(lines: PaymentDraft[], methods: PosPaymentMethod[], grandTotal: number): PaymentsState {
  const byId = new Map(methods.map((m) => [m.id, m]));
  const errors = lines.map((l) => lineError(l, byId.get(l.methodId)));
  const paidCents = lines.reduce((s, l) => s + toCents(Number(l.amount) || 0), 0);
  const remainingCents = toCents(grandTotal) - paidCents;
  const cash = lines.filter((l) => byId.get(l.methodId)?.kind === 'CASH');
  const cashLine = cash[0];
  const change =
    cashLine && cash.length === 1 && lineError(cashLine, byId.get(cashLine.methodId)) === null
      ? round2(Number(cashLine.tendered) - Number(cashLine.amount))
      : null;
  let problem: string | null = null;
  if (grandTotal > 0 && lines.length === 0) problem = 'Add a payment.';
  else if (grandTotal <= 0 && lines.length > 0) problem = 'Nothing to pay — remove the payment lines.';
  else if (cash.length > 1) problem = 'Only one cash payment per sale.';
  else if (errors.some((e) => e !== null)) problem = errors.find((e) => e !== null)!;
  else if (remainingCents > 0) problem = `₱${(remainingCents / 100).toFixed(2)} still to pay.`;
  else if (remainingCents < 0) problem = `The payments are ₱${(-remainingCents / 100).toFixed(2)} more than the total.`;
  return { errors, remaining: remainingCents / 100, valid: problem === null, cashLines: cash.length, change, problem };
}

export function paymentsPayload(lines: PaymentDraft[], methods: PosPaymentMethod[]): SalePaymentPayload[] {
  const byId = new Map(methods.map((m) => [m.id, m]));
  return lines.map((l) => {
    const isCash = byId.get(l.methodId)?.kind === 'CASH';
    return {
      payment_method_id: l.methodId,
      amount: money(Number(l.amount)),
      reference_number: l.reference.trim() || null,
      tendered_amount: isCash ? money(Number(l.tendered)) : null,
    };
  });
}
