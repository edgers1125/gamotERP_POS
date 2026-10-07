// The official receipt of a sale recorded on this device (docs/plans/sales-receipt.md). The LAYOUT — sections, order,
// wording, VAT declaration, marks, missing-details list and the reconciliation checks — is the backend's own shared
// builder, `@shared/receipt-layout` (backend/src/lib/receipt-layout.ts, the same code the web's buildReceipt runs), so
// the device's receipt is the web receipt. This file only turns a LocalSale into that builder's input:
//   * figures: the sale's payload re-priced with the SAME shared pricing code (src/sale/totals.ts); the grand total, VAT
//     and VAT-exempt sales are the payload's own, and reconciliationErrors checks the lines add up to them — the web
//     refuses a receipt that doesn't add up, the device shows it but won't print it;
//   * names, VAT / Senior-PWD flags, customer name, payment method names: the snapshot taken when the sale was rung up
//     (in memory + sales.receipt_json), else the cached catalog;
//   * business name, branch address, TIN, MIN/SN/PTU, receipt settings, POS provider: the cached bootstrap; the logo
//     from the local cache (src/sale/receiptAssets.ts).
// Renderers: src/components/sale/ReceiptView.tsx (screen — mirrors the web's SalesReceipt.tsx) and receiptTextLines
// below (ESC/POS plain text, same sections).
import {
  DEFAULT_RECEIPT_LAYOUT_SETTINGS,
  assembleReceipt,
  formatAddress,
  formatReceiptMoney,
  reconciliationErrors,
  type ReceiptData,
  type ReceiptFontKey,
  type ReceiptLayoutSettings,
  type ReceiptProviderDetails,
  type ReceiptSource,
} from '@shared/receipt-layout';
import type { PosBootstrap, PosCatalog, PosPaymentMethod } from '@pos-api/contract';
import type { LocalSale } from '../contracts';
import { localStore } from '../db/localStore';
import { computePayloadTotals } from './totals';
import { promosOf } from './promos';
import { toCents } from './money';

export type { ReceiptData } from '@shared/receipt-layout';

export interface ReceiptLineSnapshot {
  skuId: number;
  name: string;
  isVatable: boolean;
  scPwdEligible: boolean;
  // The store promo's name as it was at the sale ("Promo: <name>" on the receipt). Absent before 2026-10-08.
  promoName?: string | null;
}

export interface ReceiptSnapshot {
  lines: ReceiptLineSnapshot[];
  customerName: string | null;
  paymentMethods: PosPaymentMethod[];
  // Names as they were at the sale (receipt "Cashier: X · Sold by: Y"). Absent on snapshots saved before 2026-10-07.
  cashierName?: string | null;
  soldByName?: string | null;
}

// Snapshots of recent sales (client_uuid → snapshot); also persisted on the sale row (sales.receipt_json).
const snapshots = new Map<string, ReceiptSnapshot>();
function remember(clientUuid: string, snapshot: ReceiptSnapshot): void {
  snapshots.set(clientUuid, snapshot);
  if (snapshots.size > 200) snapshots.delete(snapshots.keys().next().value!);
}

/** Called right after a sale is recorded: kept in memory and saved with the sale (best effort). */
export function rememberReceiptSnapshot(clientUuid: string, snapshot: ReceiptSnapshot): void {
  remember(clientUuid, snapshot);
  localStore.saveReceiptSnapshot(clientUuid, JSON.stringify(snapshot)).catch(() => undefined);
}

export function receiptSnapshot(clientUuid: string): ReceiptSnapshot | null {
  return snapshots.get(clientUuid) ?? null;
}

/** Makes sure the sale's snapshot is in memory (read from sales.receipt_json after a restart). Never throws. */
export async function loadReceiptSnapshot(clientUuid: string): Promise<ReceiptSnapshot | null> {
  const have = snapshots.get(clientUuid);
  if (have) return have;
  try {
    const raw = await localStore.getReceiptSnapshot(clientUuid);
    if (!raw) return null;
    const snap = JSON.parse(raw) as ReceiptSnapshot;
    if (!snap || !Array.isArray(snap.lines)) return null;
    remember(clientUuid, snap);
    return snap;
  } catch {
    return null;
  }
}

// ---- bootstrap → the shared builder's settings (read defensively: an older cached bootstrap had a looser shape) ------

const FONTS: readonly ReceiptFontKey[] = ['ROBOTO_MONO', 'IBM_PLEX_MONO', 'JETBRAINS_MONO', 'SPACE_MONO', 'COURIER_PRIME', 'INTER', 'POPPINS'];
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function receiptLayoutSettingsOf(bootstrap: PosBootstrap | null, logoUri: string | null): ReceiptLayoutSettings {
  const r = (bootstrap?.receipt ?? null) as unknown as Record<string, unknown> | null;
  if (!r) return { ...DEFAULT_RECEIPT_LAYOUT_SETTINGS, logo_url: logoUri };
  return {
    font: FONTS.includes(r.font as ReceiptFontKey) ? (r.font as ReceiptFontKey) : DEFAULT_RECEIPT_LAYOUT_SETTINGS.font,
    paper_width: r.paper_width === 'MM_58' ? 'MM_58' : 'MM_80',
    logo_mode: r.logo_mode === 'MONOCHROME' ? 'MONOCHROME' : 'COLOR',
    show_logo: r.show_logo !== false,
    // An older cached bootstrap carried the logo inline (logo_data_url); the current one only its checksum.
    logo_url: logoUri ?? textOrNull(r.logo_data_url),
    header_lines: stringList(r.header_lines),
    message_lines: stringList(r.message_lines),
    tin_base: textOrNull(r.tin_base),
    vat_registered: r.vat_registered !== false,
  };
}

function providerOf(bootstrap: PosBootstrap | null): ReceiptProviderDetails {
  const p = (bootstrap?.pos_provider ?? null) as unknown as Record<string, unknown> | null;
  return {
    name: textOrNull(p?.name),
    address: textOrNull(p?.address),
    tin: textOrNull(p?.tin),
    accreditation_no: textOrNull(p?.accreditation_no),
    accreditation_issued_at: textOrNull(p?.accreditation_issued_at),
    accreditation_valid_until: textOrNull(p?.accreditation_valid_until),
  };
}

// ---- LocalSale → ReceiptSource → ReceiptData ---------------------------------------------------------------------------

export interface BuiltReceipt {
  data: ReceiptData;
  /** Reconciliation failures (empty = it adds up). The web refuses such a receipt; the device shows it but won't print it. */
  errors: string[];
  offline: boolean;
}

export function buildReceipt(
  sale: LocalSale,
  bootstrap: PosBootstrap | null,
  catalog: PosCatalog | null,
  opts: { logoUri: string | null; reprint: boolean },
): BuiltReceipt {
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
  const methods = new Map([...(bootstrap?.payment_methods ?? []), ...(catalog?.payment_methods ?? []), ...(snap?.paymentMethods ?? [])].map((m) => [m.id, m]));
  const terminal = bootstrap?.terminal ?? null;

  const staffName = (id: number) => bootstrap?.sales_staff.find((s) => s.id === id)?.name ?? null;
  const holderName = statutory ? [statutory.first_name, statutory.middle_name, statutory.last_name].filter(Boolean).join(' ') : null;
  const clientName = snap?.customerName ?? holderName;

  const source: ReceiptSource = {
    isReturn: false, // refunds are online-only and have no device receipt
    voided: !!sale.voided,
    printCount: opts.reprint ? 1 : 0,
    // The server's S-<branch>-<id>, known once the sale has synced.
    saleReference: sale.sync_result?.reference ?? null,
    invoiceNumber: sale.invoice_number,
    createdAt: new Date(p.sold_at),
    companyName: terminal?.company.name ?? '—',
    branchAddress: terminal?.branch.address ?? '',
    branchTinCode: terminal?.branch.tin_branch_code ?? null,
    terminal: terminal
      ? { code: terminal.code, birMin: terminal.bir.min, serialNumber: terminal.bir.serial_number, ptuNumber: terminal.bir.ptu_number }
      : null,
    statutory: statutory ? { type: statutory.type, idNumber: statutory.id_number, holderName } : null,
    // An existing client's address isn't on the device; a Senior/PWD card's address typed at the sale is.
    client: clientName ? { name: clientName, address: statutory?.address ? formatAddress(statutory.address) : null } : null,
    // "Cashier: X · Sold by: Y" — from the snapshot taken at the sale, else today's Sales Staff list.
    cashierName: snap?.cashierName ?? staffName(p.cashier_user_id),
    soldByName: snap?.soldByName ?? staffName(p.sold_by_user_id),
    lines: p.lines.map((l, idx) => {
      const c = totals.lines[idx]!;
      // A promo-priced line: "qty × regular = regular amount" then "Promo: <name> −x" (shared layout; nothing printed
      // when the regular price was charged — a Senior/PWD line where the cashier chose the 20 %).
      const promoName =
        l.promo_id != null && l.regular_unit_price
          ? (snapById.get(l.sku_id)?.promoName ?? promosOf(bootstrap).find((pr) => pr.id === l.promo_id)?.name ?? 'Store promo')
          : null;
      return {
        promo: promoName !== null ? { name: promoName, regularUnitPrice: toCents(Number(l.regular_unit_price)) } : null,
        name: infoOf(l.sku_id).name,
        quantity: l.quantity,
        unitPrice: toCents(Number(l.unit_price)),
        itemDiscount: toCents(c.itemDiscountAmount),
        statutoryDiscount: toCents(c.statutoryDiscountAmount),
        taxableBase: toCents(c.taxableBase),
        vat: toCents(c.vatAmount),
        lineTotal: toCents(c.lineTotal),
        isVatable: c.isVatable,
        isStatutory: c.isStatutory,
      };
    }),
    // The payload's own totals — what the server stores.
    totalVat: toCents(Number(p.totals.total_vat)),
    grandTotal: toCents(Number(p.totals.grand_total)),
    vatExemptSales: toCents(Number(p.totals.vat_exempt_sales)),
    payments: p.payments.map((pay) => {
      const m = methods.get(pay.payment_method_id);
      const amount = toCents(Number(pay.amount));
      const tendered = pay.tendered_amount != null && pay.tendered_amount !== '' ? toCents(Number(pay.tendered_amount)) : null;
      return {
        methodName: m?.name ?? `Payment #${pay.payment_method_id}`,
        methodKind: m?.kind ?? 'OTHER',
        amount,
        reference: pay.reference_number ?? null,
        tendered,
        // Same as the server's stored change_amount (lib/record-sale.ts).
        change: tendered === null ? null : tendered - amount,
      };
    }),
  };

  const data = assembleReceipt(source, receiptLayoutSettingsOf(bootstrap, opts.logoUri), providerOf(bootstrap));
  return { data, errors: reconciliationErrors(source, data), offline: p.offline };
}

// ---- Plain text (ESC/POS): the same sections, order and wording as the screen / web receipt -------------------------
// 48 columns on 80 mm paper, 32 on 58 mm. Money without a currency sign, like the web receipt's columns. The logo and
// the VOID watermark are graphics — not part of the text receipt (the VOID banner is).

function center(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(Math.floor((w - s.length) / 2)) + s;
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
/** Label left, value right, `padRight` columns kept free after the value (so it lines up with the item Amount column). */
function lr(left: string, right: string, w: number, padRight = 0): string[] {
  const end = w - padRight;
  const room = end - right.length - 1;
  const label = wrap(left, Math.max(room, 8));
  const last = label.pop()!;
  if (last.length <= room) return [...label, last + ' '.repeat(end - last.length - right.length) + right];
  return [...label, last, ' '.repeat(Math.max(end - right.length, 0)) + right];
}
const rpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const dash = (v: string | null) => (v && v.trim() ? v : '—');

export function receiptTextLines(r: ReceiptData): string[] {
  const narrow = r.settings.paper_width === 'MM_58';
  const w = narrow ? 32 : 48;
  const out: string[] = [];
  const push = (...xs: string[]) => out.push(...xs);
  const rule = () => push('-'.repeat(w));
  const centered = (s: string) => (s ? wrap(s, w).forEach((l) => push(center(l, w))) : push(''));
  const banner = (s: string) => push('='.repeat(w), center(s.split('').join(' '), w), '='.repeat(w));
  const m = formatReceiptMoney;
  // Web item grid: 80 mm "1fr 6ch 10ch 11ch 2ch", 58 mm "1fr 7ch 9ch 10ch 2ch".
  const [qW, pW, aW, fW] = narrow ? [7, 9, 10, 2] : [6, 10, 11, 2];
  const col = fW + 1; // the V/E column + its gap, kept free right of every money row below the items
  const cols = (q: string, pr: string, a: string, f: string) => rpad(`${rpad(q, qW)} ${rpad(pr, pW)} ${rpad(a, aW)} ${rpad(f, fW)}`, w);

  // 10. Marks
  if (r.marks.voided) banner('VOID');
  if (r.marks.is_return) banner('RETURN');
  if (r.marks.reprint) push(center('*** REPRINT ***', w), '');
  // 2. Heading
  centered(r.heading.business_name);
  r.heading.fixed_lines.forEach(centered);
  if (r.heading.custom_lines.length > 0) {
    push('');
    r.heading.custom_lines.forEach(centered);
  }
  rule();
  // 3. Sale type + customer type, POS + customer name
  push(...lr(r.sale_type_label, r.customer_type_label ?? '', w));
  if (r.terminal_label || r.customer_name) push(...lr(r.terminal_label ?? '', r.customer_name ?? '', w));
  rule();
  // 4. Transaction details — the name on its own line, then Qty / Price / Amount / flag right-aligned.
  push('Item' + cols('Qty', 'Price', 'Amount', '').slice(4));
  for (const it of r.items) {
    push(...wrap(it.name, w));
    // A promo-priced item (shared layout `promo`): the regular price and amount, then "Promo: <name>" and its discount —
    // the column still adds up (like the web's SalesReceipt).
    push(cols(String(it.quantity), m(it.promo ? it.promo.regular_unit_price : it.unit_price), m(it.promo ? it.promo.regular_amount : it.amount), it.vat_flag));
    if (it.promo) push(...lr(it.promo.label, m(it.promo.discount), w, col));
  }
  if (r.adjustments.length > 0) push('');
  for (const a of r.adjustments) push(...lr(a.label, m(a.amount), w, col));
  push('='.repeat(w));
  push(...lr(`TOTAL: ${r.item_count} Item${r.item_count === 1 ? '' : 's'}`, m(r.total), w, col));
  for (const p of r.payments) push(...lr(p.reference ? `${p.label} ${p.reference}` : p.label, m(p.amount), w, col));
  if (r.cash_received !== null) push(...lr('Cash received', m(r.cash_received), w, col));
  if (r.change !== null) push(...lr('CHANGE', m(r.change), w, col));
  rule();
  // 5. VAT declaration
  push(...lr('VAT Sales', m(r.vat.vat_sales), w, col));
  push(...lr('Non-VAT Sales (VAT-exempt)', m(r.vat.non_vat_sales), w, col));
  push(...lr('Zero-Rated Sales', m(r.vat.zero_rated_sales), w, col));
  push(...lr('Total Sales', m(r.vat.total_sales), w, col));
  push(...lr('Total VAT', m(r.vat.total_vat), w, col));
  push(...lr('Total Amount', m(r.vat.total_amount), w, col));
  push(...lr('Total Discount', m(r.vat.total_discount), w, col));
  push(...lr('VAT Exemption', m(r.vat.vat_exemption), w, col));
  push(...wrap('V = Vatable · E = VAT-exempt · Z = Zero-rated', w));
  rule();
  // 6. Trans No. + date/time (+ the server reference once synced)
  push(...lr('Trans No.', r.invoice_number ?? '—', w));
  push(...lr('Date', r.issued_at_display, w));
  if (r.sale_reference) push(...lr('Ref', r.sale_reference, w));
  // "Cashier: X · Sold by: Y" (shared receipt-layout; null on an older snapshot without names).
  if (r.staff_line) push(...wrap(r.staff_line, w));
  rule();
  // 7. Title line + messages
  centered(r.title_line);
  if (r.message_lines.length > 0) {
    push('');
    r.message_lines.forEach(centered);
  }
  rule();
  // 8. Customer block — "Label: value", or a line to write on
  const writeOn = (label: string, value: string | null) => {
    push('');
    if (value) push(...wrap(`${label}: ${value}`, w));
    else push(`${label}: ${'_'.repeat(Math.max(w - label.length - 2, 4))}`);
  };
  writeOn('Customer', r.customer_block.name);
  writeOn('Address', r.customer_block.address);
  writeOn('TIN', r.customer_block.tin);
  writeOn(r.customer_block.id_label, r.customer_block.id_number);
  writeOn('Signature', null);
  rule();
  // 9. Other information (BIR), centred
  const pv = r.provider;
  centered('POS System Provider');
  centered(dash(pv.name));
  centered(dash(pv.address));
  centered(`TIN: ${dash(pv.tin)}`);
  centered(`BIR Accreditation No.: ${dash(pv.accreditation_no)}`);
  centered(`Issued: ${dash(pv.accreditation_issued)} · Until: ${dash(pv.accreditation_valid_until)}`);
  centered(`PTU No.: ${dash(pv.ptu_no)}`);
  push('');
  centered(pv.validity_note);
  if (r.marks.reprint) push('', center('*** REPRINT ***', w));
  return out;
}
