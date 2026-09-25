// Turns a locally recorded sale into what the official receipt shows (docs/plans/sales-receipt.md — the same layout
// and wording as the backend's lib/receipt.ts, built on the device so it can print offline). Figures come from the
// sale's own payload re-priced with the SAME shared code (src/sale/totals.ts); names, VAT flags and the customer name
// come from a snapshot taken when the sale was rung up (kept in memory) or, for a later reprint, from the cached
// catalog. The grand total printed is always the payload's.
import type { PosBootstrap, PosCatalog, PosPaymentMethod } from '@pos-api/contract';
import type { LocalSale } from '../contracts';
import { computePayloadTotals } from './totals';
import { formatPeso, money, round2 } from './money';

export interface ReceiptLineSnapshot {
  skuId: number;
  name: string;
  isVatable: boolean;
  scPwdEligible: boolean;
}

export interface ReceiptSnapshot {
  lines: ReceiptLineSnapshot[];
  customerName: string | null;
  paymentMethods: PosPaymentMethod[];
}

// Snapshots of sales rung up since the app started (client_uuid → snapshot).
const snapshots = new Map<string, ReceiptSnapshot>();
export function rememberReceiptSnapshot(clientUuid: string, snapshot: ReceiptSnapshot): void {
  snapshots.set(clientUuid, snapshot);
  if (snapshots.size > 200) snapshots.delete(snapshots.keys().next().value!);
}
export function receiptSnapshot(clientUuid: string): ReceiptSnapshot | null {
  return snapshots.get(clientUuid) ?? null;
}

export type VatFlag = 'V' | 'E' | 'Z';

export interface ReceiptModel {
  businessName: string;
  fixedLines: string[];
  customLines: string[];
  saleTypeLabel: string;
  terminalLabel: string | null;
  customerTypeLabel: 'SENIOR CITIZEN' | 'PWD' | null;
  customerName: string | null;
  items: { name: string; quantity: number; unitPrice: string; amount: string; vatFlag: VatFlag }[];
  adjustments: { label: string; amount: string }[];
  itemCount: number;
  total: string;
  payments: { label: string; amount: string; reference: string | null }[];
  cashReceived: string | null;
  change: string | null;
  vat: {
    vatSales: string;
    nonVatSales: string;
    zeroRatedSales: string;
    totalSales: string;
    totalVat: string;
    totalAmount: string;
    totalDiscount: string;
    vatExemption: string;
  };
  invoiceNumber: string;
  issuedAtDisplay: string;
  titleLine: 'THIS IS YOUR OFFICIAL RECEIPT';
  messageLines: string[];
  customerBlock: { name: string | null; address: string | null; tin: string | null; idLabel: string; idNumber: string | null };
  provider: {
    name: string | null;
    address: string | null;
    tin: string | null;
    accreditationNo: string | null;
    accreditationIssued: string | null;
    accreditationValidUntil: string | null;
    ptuNo: string | null;
    validityNote: string;
  };
  paperWidth: 'MM_80' | 'MM_58';
  missingRequired: string[];
  offline: boolean;
}

const VAT_RATE = 0.12;
const VALIDITY_NOTE = 'THIS RECEIPT SHALL BE VALID FOR FIVE (5) YEARS FROM THE DATE OF THE PERMIT TO USE';

function str(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function lines(obj: Record<string, unknown> | null | undefined, key: string): string[] {
  const v = obj?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** YYYY-MM-DD (or an ISO instant) → MM/DD/YYYY. */
function mdY(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : value;
}

const manilaFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** MM/DD/YYYY HH:mm:ss, Asia/Manila. */
export function manilaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(manilaFmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`;
}

export function buildReceipt(sale: LocalSale, bootstrap: PosBootstrap | null, catalog: PosCatalog | null): ReceiptModel {
  const p = sale.payload;
  const snap = receiptSnapshot(sale.client_uuid);
  const catalogById = new Map((catalog?.items ?? []).map((i) => [i.sku_id, i]));
  const snapById = new Map((snap?.lines ?? []).map((l) => [l.skuId, l]));
  const infoOf = (skuId: number) => {
    const s = snapById.get(skuId);
    if (s) return { name: s.name, isVatable: s.isVatable, scPwdEligible: s.scPwdEligible };
    const c = catalogById.get(skuId);
    return c ? { name: c.final_name, isVatable: c.is_vatable, scPwdEligible: c.sc_pwd_eligible } : { name: `SKU #${skuId}`, isVatable: true, scPwdEligible: false };
  };
  const totals = computePayloadTotals(p, (id) => infoOf(id));
  const statutory = p.statutory_discount ?? null;

  const items = p.lines.map((l, idx) => {
    const c = totals.lines[idx]!;
    return {
      name: infoOf(l.sku_id).name,
      quantity: l.quantity,
      unitPrice: money(Number(l.unit_price)),
      amount: money(c.lineSubtotal),
      vatFlag: (c.isStatutory || !c.isVatable ? 'E' : 'V') as VatFlag,
    };
  });

  // Same adjustment rows, in the same order, as lib/receipt.ts.
  const txApplied = round2(
    totals.lines.reduce((s, l) => s + (l.isStatutory ? 0 : l.lineSubtotal - l.itemDiscountAmount - l.taxableBase), 0),
  );
  const adjustments: { label: string; amount: string }[] = [];
  if (totals.totalStatutoryDiscount > 0)
    adjustments.push({ label: statutory?.type === 'PWD' ? 'Less 20% PWD Discount' : 'Less 20% SC Discount', amount: money(-totals.totalStatutoryDiscount) });
  if (totals.totalItemDiscount > 0) adjustments.push({ label: 'Less item discounts', amount: money(-totals.totalItemDiscount) });
  if (txApplied > 0) adjustments.push({ label: 'Less discount', amount: money(-txApplied) });
  if (totals.totalVat > 0) adjustments.push({ label: 'Add 12% VAT', amount: money(totals.totalVat) });

  const methods = new Map([...(bootstrap?.payment_methods ?? []), ...(catalog?.payment_methods ?? []), ...(snap?.paymentMethods ?? [])].map((m) => [m.id, m]));
  const payments = p.payments.map((pay) => {
    const m = methods.get(pay.payment_method_id);
    return {
      label: m?.kind === 'CASH' ? 'Cash' : (m?.name ?? `Payment #${pay.payment_method_id}`),
      amount: money(Number(pay.amount)),
      reference: pay.reference_number ?? null,
    };
  });
  const cash = p.payments.find((pay) => methods.get(pay.payment_method_id)?.kind === 'CASH' && pay.tendered_amount != null);
  const allCash = p.payments.length > 0 && p.payments.every((pay) => methods.get(pay.payment_method_id)?.kind === 'CASH');
  const saleTypeLabel =
    p.payments.length === 0
      ? 'SALES'
      : allCash
        ? 'CASH SALES'
        : [...new Set(p.payments.map((pay) => (methods.get(pay.payment_method_id)?.name ?? 'OTHER').toUpperCase()))].join(' / ');

  const vatSales = round2(totals.lines.reduce((s, l) => s + (!l.isStatutory && l.isVatable ? l.taxableBase : 0), 0));
  const nonVatSales = round2(totals.lines.reduce((s, l) => s + (l.isStatutory || !l.isVatable ? l.taxableBase : 0), 0));
  const vatExemption = round2(
    totals.lines.reduce((s, l) => s + (l.isStatutory && l.isVatable ? round2(VAT_RATE * (l.lineSubtotal - l.itemDiscountAmount)) : 0), 0),
  );
  const totalSales = round2(vatSales + nonVatSales);

  const terminal = bootstrap?.terminal ?? null;
  const settings = bootstrap?.receipt ?? null;
  const provider = bootstrap?.pos_provider ?? null;
  const tinBase = str(settings, 'tin_base');
  const tinBranch = terminal?.branch.tin_branch_code ?? null;
  const vatRegistered = settings?.vat_registered !== false;
  const min = terminal?.bir.min ?? null;
  const sn = terminal?.bir.serial_number ?? null;
  const ptu = terminal?.bir.ptu_number ?? null;

  const holderName = statutory ? [statutory.first_name, statutory.middle_name, statutory.last_name].filter(Boolean).join(' ') : null;
  const customerName = holderName || snap?.customerName || null;

  const missingRequired: string[] = [];
  if (!tinBase) missingRequired.push('TIN');
  if (!tinBranch) missingRequired.push('TIN branch code');
  if (!min) missingRequired.push('MIN');
  if (!sn) missingRequired.push('SN');
  if (!str(provider, 'name')) missingRequired.push('POS provider name');
  if (!str(provider, 'address')) missingRequired.push('POS provider address');
  if (!str(provider, 'tin')) missingRequired.push('POS provider TIN');
  if (!str(provider, 'accreditation_no')) missingRequired.push('BIR Accreditation No.');
  if (!str(provider, 'accreditation_issued_at') || !str(provider, 'accreditation_valid_until')) missingRequired.push('Accreditation dates');
  if (!ptu) missingRequired.push('PTU No.');

  const paperWidth = str(settings, 'paper_width') === 'MM_58' ? 'MM_58' : 'MM_80';

  return {
    businessName: terminal?.company.name ?? '—',
    fixedLines: [
      terminal?.branch.address ?? '—',
      `${vatRegistered ? 'VAT Registered' : 'Non-VAT Registered'} TIN ${tinBase ?? '—'}-${tinBranch ?? '—'}`,
      `MIN: ${min ?? '—'}`,
      `SN: ${sn ?? '—'}`,
    ],
    customLines: lines(settings, 'header_lines'),
    saleTypeLabel,
    terminalLabel: terminal ? `POS ${terminal.code}` : null,
    customerTypeLabel: statutory ? (statutory.type === 'PWD' ? 'PWD' : 'SENIOR CITIZEN') : null,
    customerName,
    items,
    adjustments,
    itemCount: p.lines.reduce((s, l) => s + Math.abs(l.quantity), 0),
    total: money(Number(p.totals.grand_total)),
    payments,
    cashReceived: cash ? money(Number(cash.tendered_amount)) : null,
    change: cash ? money(Number(cash.tendered_amount) - Number(cash.amount)) : null,
    vat: {
      vatSales: money(vatSales),
      nonVatSales: money(nonVatSales),
      zeroRatedSales: money(0),
      totalSales: money(totalSales),
      totalVat: money(Number(p.totals.total_vat)),
      totalAmount: money(Number(p.totals.grand_total)),
      totalDiscount: money(Number(p.totals.total_statutory_discount) + Number(p.totals.total_item_discount) + Number(p.totals.transaction_discount_amount)),
      vatExemption: money(vatExemption),
    },
    invoiceNumber: sale.invoice_number,
    issuedAtDisplay: manilaDateTime(p.sold_at),
    titleLine: 'THIS IS YOUR OFFICIAL RECEIPT',
    messageLines: lines(settings, 'message_lines'),
    customerBlock: {
      name: customerName,
      address: null,
      tin: null,
      idLabel: statutory ? (statutory.type === 'PWD' ? 'PWD ID No' : 'SC ID No') : 'ID No',
      idNumber: statutory?.id_number ?? null,
    },
    provider: {
      name: str(provider, 'name'),
      address: str(provider, 'address'),
      tin: str(provider, 'tin'),
      accreditationNo: str(provider, 'accreditation_no'),
      accreditationIssued: mdY(str(provider, 'accreditation_issued_at')),
      accreditationValidUntil: mdY(str(provider, 'accreditation_valid_until')),
      ptuNo: ptu,
      validityNote: VALIDITY_NOTE,
    },
    paperWidth,
    missingRequired,
    offline: p.offline,
  };
}

// ---- Plain text (for an ESC/POS printer; 48 columns on 80 mm paper, 32 on 58 mm) ----------------------------------

function center(s: string, w: number): string {
  if (s.length >= w) return s;
  const pad = Math.floor((w - s.length) / 2);
  return ' '.repeat(pad) + s;
}
function lr(left: string, right: string, w: number): string {
  const space = w - left.length - right.length;
  if (space >= 1) return left + ' '.repeat(space) + right;
  return `${left}\n${' '.repeat(Math.max(w - right.length, 0))}${right}`;
}
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > w) {
    const cut = rest.lastIndexOf(' ', w);
    const at = cut > 0 ? cut : w;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}
const amt = (s: string) => formatPeso(s).replace('₱', 'P');

export function receiptTextLines(r: ReceiptModel, opts: { reprint?: boolean } = {}): string[] {
  const w = r.paperWidth === 'MM_58' ? 32 : 48;
  const rule = '-'.repeat(w);
  const out: string[] = [];
  const push = (...xs: string[]) => xs.forEach((x) => out.push(...x.split('\n')));
  if (opts.reprint) push(center('*** REPRINT ***', w));
  wrap(r.businessName, w).forEach((l) => push(center(l, w)));
  r.fixedLines.forEach((l) => wrap(l, w).forEach((x) => push(center(x, w))));
  r.customLines.forEach((l) => push(center(l, w)));
  push(rule);
  push(lr(r.saleTypeLabel, r.customerTypeLabel ?? '', w));
  if (r.terminalLabel || r.customerName) push(lr(r.terminalLabel ?? '', r.customerName ?? '', w));
  push(rule);
  for (const it of r.items) {
    wrap(it.name, w).forEach((l) => push(l));
    push(lr(`  ${it.quantity} x ${amt(it.unitPrice)}`, `${amt(it.amount)} ${it.vatFlag}`, w));
  }
  for (const a of r.adjustments) push(lr(a.label, amt(a.amount), w));
  push(rule);
  push(lr(`TOTAL: ${r.itemCount} Item${r.itemCount === 1 ? '' : 's'}`, amt(r.total), w));
  for (const pay of r.payments) push(lr(pay.reference ? `${pay.label} ref ${pay.reference}` : pay.label, amt(pay.amount), w));
  if (r.cashReceived !== null) {
    push(lr('Cash received', amt(r.cashReceived), w));
    push(lr('CHANGE', amt(r.change ?? '0'), w));
  }
  push(rule);
  push(lr('VAT Sales', amt(r.vat.vatSales), w));
  push(lr('Non-VAT Sales', amt(r.vat.nonVatSales), w));
  push(lr('Zero-Rated Sales', amt(r.vat.zeroRatedSales), w));
  push(lr('Total Sales', amt(r.vat.totalSales), w));
  push(lr('Total VAT', amt(r.vat.totalVat), w));
  push(lr('Total Amount', amt(r.vat.totalAmount), w));
  push(lr('Total Discount', amt(r.vat.totalDiscount), w));
  push(lr('VAT Exemption', amt(r.vat.vatExemption), w));
  push(rule);
  push(lr('Trans No.', r.invoiceNumber, w));
  push(lr('Date', r.issuedAtDisplay, w));
  push('');
  push(center(r.titleLine, w));
  r.messageLines.forEach((l) => push(center(l, w)));
  push(rule);
  const blank = '_'.repeat(Math.max(w - 12, 8));
  push(`Customer: ${r.customerBlock.name ?? blank}`);
  push(`Address: ${r.customerBlock.address ?? blank}`);
  push(`TIN: ${r.customerBlock.tin ?? blank}`);
  push(`${r.customerBlock.idLabel}: ${r.customerBlock.idNumber ?? blank}`);
  push(`Signature: ${blank}`);
  push(rule);
  const pv = r.provider;
  push(`POS Provider: ${pv.name ?? '—'}`);
  wrap(`Address: ${pv.address ?? '—'}`, w).forEach((l) => push(l));
  push(`TIN: ${pv.tin ?? '—'}`);
  push(`BIR Accreditation No.: ${pv.accreditationNo ?? '—'}`);
  push(`Issued: ${pv.accreditationIssued ?? '—'}  Until: ${pv.accreditationValidUntil ?? '—'}`);
  push(`PTU No.: ${pv.ptuNo ?? '—'}`);
  wrap(pv.validityNote, w).forEach((l) => push(center(l, w)));
  return out;
}
