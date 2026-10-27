// The prescription (Rx) step of a sale — the tablet half of GamotERP docs/plans/pos-rx-step.md (contract "Prescriptions —
// the POS Rx step"). Pure: no API, no DB, no React (scripts/rx-selftest.ts runs it under tsx).
//   * Which cart lines need a prescription (catalog `rx_required` / `is_dangerous_drug`; a dangerous drug is always Rx)
//     and their PIECES per product model (quantity × pack_quantity, summed per model — several pack sizes of one model
//     fill the same prescription item).
//   * The cashier's draft: a NEW prescription (doctor from the cached doctors list, date, quantity prescribed per Rx model,
//     PTR / S2 only when the doctor has none, dangerous drugs: form serial + patient address) or FILL an open prescription
//     of the client (fetched online during this sale — offline there is no fill).
//   * The LOCAL checks (`localRxIssues`) — the server's rules (backend lib/prescriptions.ts checkSalePrescription) with the
//     same codes, paths and wording, for everything the tablet can know offline. Online the server's
//     POST /pos/prescriptions/check has the last word before charging (serial already on file, doctor deactivated…);
//     offline the sale is recorded and the server re-checks at sync (never a rejection — PRESCRIPTION_ISSUE + code).
//   * The payload (`prescriptionPayload`): NEW → doctor_id + date + items (+ PTR / S2 only when the doctor's are null,
//     serial / patient address only for dangerous drugs); never prescriber_name / _prc_license_no / _clinic. FILL →
//     { prescription_id } only.
import { businessDate } from '@shared/business-day';
import type {
  PosOpenPrescription,
  PosPrescriptionCheckRequest,
  PosPrescriptionDoctor,
  PosRxIssue,
  PosRxIssueCode,
  SaleClientPayload,
  SalePrescriptionPayload,
  SaleStatutoryPayload,
} from '@pos-api/contract';
import type { SaleClient } from './cart';
import { addressStarted, missingAddressFields, type StatutoryDraft } from './statutory';

// The server's windows (lib/prescriptions.ts RX_VALIDITY_DAYS / DD_RX_VALIDITY_DAYS / MAX_PRESCRIBED_PIECES).
export const RX_VALIDITY_DAYS = 180;
export const DD_RX_VALIDITY_DAYS = 30;
export const MAX_PRESCRIBED_PIECES = 1_000_000;
// Field limits of the sale's prescription schema (contract SalePrescriptionPayload).
const MAX_PTR = 30;
const MAX_S2 = 30;
const MAX_SERIAL = 50;
const MAX_ADDRESS = 600;

export const DOCTOR_REQUIRED_MESSAGE = "Choose the prescribing doctor from the doctors list (add the doctor there if they're not on it yet)";

/** A cart line as the Rx rules see it (`rxLineOf` in cart.ts builds it). ALL cart lines, in cart order — issue paths
 * `['items', i, …]` index this list, exactly like the check request's `lines`. */
export interface RxLineInput {
  skuId: number;
  name: string;
  quantity: number;
  packQuantity: number;
  modelId: number | null;
  modelName: string;
  rxRequired: boolean;
  dangerous: boolean;
}

/** One prescription-only product model of the cart. */
export interface RxModel {
  modelId: number;
  modelName: string;
  /** Pieces in this sale (quantity × pack_quantity over every line of the model). */
  pieces: number;
  /** Any line of the model is a dangerous drug. */
  dangerous: boolean;
  /** Indexes of the cart lines of this model. */
  lineIndexes: number[];
}

export function isRxLine(l: Pick<RxLineInput, 'rxRequired' | 'dangerous'>): boolean {
  return l.rxRequired || l.dangerous;
}

export function cartNeedsRx(lines: readonly Pick<RxLineInput, 'rxRequired' | 'dangerous'>[]): boolean {
  return lines.some(isRxLine);
}

/** The cart's Rx models in first-line order, and Rx lines whose SKU has no model (can't go on a prescription). */
export function rxModelsOf(lines: readonly RxLineInput[]): { models: RxModel[]; noModel: number[] } {
  const byId = new Map<number, RxModel>();
  const noModel: number[] = [];
  lines.forEach((l, idx) => {
    if (!isRxLine(l)) return;
    if (l.modelId === null) {
      noModel.push(idx);
      return;
    }
    const pieces = l.quantity * Math.max(1, l.packQuantity);
    const m = byId.get(l.modelId);
    if (m) {
      m.pieces += pieces;
      m.dangerous = m.dangerous || l.dangerous;
      m.lineIndexes.push(idx);
    } else {
      byId.set(l.modelId, { modelId: l.modelId, modelName: l.modelName || l.name, pieces, dangerous: l.dangerous, lineIndexes: [idx] });
    }
  });
  return { models: [...byId.values()], noModel };
}

// ---- the draft ------------------------------------------------------------------------------------------------------

export interface RxNewDraft {
  mode: 'NEW';
  doctorId: number | null;
  /** YYYY-MM-DD as typed. */
  date: string;
  /** Quantity prescribed (pieces) per model id, as typed. Pre-filled with the cart's pieces. */
  quantities: Record<number, string>;
  /** Typed only when the doctor has none on file. */
  ptr: string;
  s2: string;
  /** Dangerous drugs only. */
  serial: string;
  patientAddress: string;
}

export interface RxFillDraft {
  mode: 'FILL';
  /** Fetched online during THIS sale (GET /pos/clients/:id/open-prescriptions) — its remaining pieces are re-checked. */
  prescription: PosOpenPrescription;
  /** The client it was fetched for (a different client → RX_OTHER_CLIENT). */
  clientId: number;
}

export type RxDraft = RxNewDraft | RxFillDraft;

export function newRxDraft(models: readonly RxModel[], today: string): RxNewDraft {
  const quantities: Record<number, string> = {};
  for (const m of models) quantities[m.modelId] = String(m.pieces);
  return { mode: 'NEW', doctorId: null, date: today, quantities, ptr: '', s2: '', serial: '', patientAddress: '' };
}

/** After the cart changed: a model new to the draft is pre-filled with its pieces; models no longer in the cart are
 * dropped; typed quantities are kept. */
export function withCartModels(draft: RxNewDraft, models: readonly RxModel[]): RxNewDraft {
  const quantities: Record<number, string> = {};
  for (const m of models) quantities[m.modelId] = draft.quantities[m.modelId] ?? String(m.pieces);
  const same = Object.keys(quantities).length === Object.keys(draft.quantities).length && models.every((m) => draft.quantities[m.modelId] === quantities[m.modelId]);
  return same ? draft : { ...draft, quantities };
}

// ---- the patient ----------------------------------------------------------------------------------------------------

export interface RxPatient {
  /** First + last name known — an existing client or a registered new one; never "No client details". */
  named: boolean;
  /** The existing client's id (open prescriptions are per client); null for a new one. */
  clientId: number | null;
  /** An address on record or on the Senior/PWD card being entered (dangerous drugs need one, unless typed). */
  hasAddress: boolean;
}

function filled(s: string | null | undefined): boolean {
  return (s ?? '').trim() !== '';
}

export function rxPatientOf(client: SaleClient, statutory: StatutoryDraft | null): RxPatient {
  const cardAddress = statutory !== null && addressStarted(statutory.address) && missingAddressFields(statutory.address).length === 0;
  if (client.kind === 'EXISTING') {
    const c = client.client;
    return { named: filled(c.first_name) && filled(c.last_name), clientId: c.id, hasAddress: c.has_address === true || cardAddress };
  }
  if (client.kind === 'NEW') return { named: filled(client.firstName) && filled(client.lastName), clientId: null, hasAddress: cardAddress };
  return { named: false, clientId: null, hasAddress: false };
}

/** Why the client step can't be used for an Rx sale (null = fine) — the Sell screen shows it with "No client details"
 * disabled. */
export const RX_WALK_IN_REASON = 'A prescription item needs the patient as the client — search or register them (not “No client details”).';

// ---- dates ----------------------------------------------------------------------------------------------------------

export function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/** The server's prescriptionDateProblem (same codes and wording). */
export function prescriptionDateProblem(prescriptionDate: string, saleDate: string, dangerous: boolean): { code: PosRxIssueCode; message: string } | null {
  const age = dayNumber(saleDate) - dayNumber(prescriptionDate);
  if (age < 0) return { code: 'RX_DATE_AFTER_SALE', message: `The prescription date (${prescriptionDate}) can't be after the sale date (${saleDate})` };
  const window = dangerous ? DD_RX_VALIDITY_DAYS : RX_VALIDITY_DAYS;
  if (age > window) {
    return { code: 'RX_EXPIRED', message: `This ${dangerous ? 'dangerous-drugs ' : ''}prescription is dated ${prescriptionDate} — it can only be filled within ${window} days of its date` };
  }
  return null;
}

/** The Manila sale day of `at` (the sale is judged on it, like the server's sync). */
export function rxSaleDay(at: Date = new Date()): string {
  return businessDate(at);
}

/** A typed quantity → whole pieces 1..MAX, else null. */
export function parsePieces(text: string | undefined): number | null {
  const t = (text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_PRESCRIBED_PIECES ? n : null;
}

// ---- the local checks -----------------------------------------------------------------------------------------------

export interface RxCheckInput {
  lines: readonly RxLineInput[];
  patient: RxPatient;
  draft: RxDraft | null;
  /** The cached doctors list (src/sale/doctors.ts). */
  doctors: readonly PosPrescriptionDoctor[];
  /** The sale day, YYYY-MM-DD (Manila). */
  today: string;
}

/** Everything the tablet can check itself, as the server would word it ([] = nothing found; the cart has no Rx line →
 * always []). */
export function localRxIssues(p: RxCheckInput): PosRxIssue[] {
  const { models, noModel } = rxModelsOf(p.lines);
  if (models.length === 0 && noModel.length === 0) return [];
  const issues: PosRxIssue[] = [];
  for (const idx of noModel) {
    issues.push({
      code: 'RX_INCOMPLETE',
      path: ['items', idx, 'sku_id'],
      message: `${p.lines[idx]!.name} has no product model in the price list, so it can't go on a prescription — refresh the price list (Check-in → Sync now)`,
    });
  }
  const names = models.map((m) => m.modelName).join(', ');
  if (!p.patient.named) {
    issues.push({
      code: 'RX_CLIENT_NOT_NAMED',
      path: ['client_id'],
      message: `A prescription item (${names}) needs a named client — enter the patient's first and last name (not an anonymous walk-in)`,
    });
  }
  const d = p.draft;
  if (!d) {
    issues.push({ code: 'RX_REQUIRED', path: ['prescription'], message: `${names} ${models.length === 1 ? 'is' : 'are'} prescription-only — enter the prescription` });
    return issues;
  }
  const anyDangerous = models.some((m) => m.dangerous);

  if (d.mode === 'FILL') {
    const rx = d.prescription;
    const ref = rx.reference;
    if (p.patient.clientId === null || p.patient.clientId !== d.clientId) {
      issues.push({ code: 'RX_OTHER_CLIENT', path: ['prescription', 'prescription_id'], message: "This prescription is another client's — choose the patient it was written for" });
      return issues;
    }
    const dateProblem = isYmd(rx.prescription_date) ? prescriptionDateProblem(rx.prescription_date, p.today, rx.is_dangerous_drug) : null;
    if (dateProblem) issues.push({ code: dateProblem.code, path: ['prescription', 'prescription_id'], message: `${ref}: ${dateProblem.message}` });
    if (anyDangerous && !rx.is_dangerous_drug) {
      issues.push({ code: 'RX_NOT_DANGEROUS_DRUGS', path: ['prescription', 'prescription_id'], message: `${ref} is not a dangerous-drugs prescription — a dangerous drug needs the S2 prescription` });
    }
    if (rx.is_dangerous_drug && rx.items.some((i) => i.quantity_filled > 0)) {
      issues.push({
        code: 'RX_DD_ALREADY_FILLED',
        path: ['prescription', 'prescription_id'],
        message: `${ref} is a dangerous-drugs prescription and was already filled — it can be filled only once (the pharmacy keeps the form)`,
      });
    }
    for (const m of models) {
      const item = rx.items.find((i) => i.product_model_id === m.modelId);
      const idx = m.lineIndexes[0]!;
      if (!item) {
        issues.push({ code: 'RX_ITEM_NOT_ON_PRESCRIPTION', path: ['items', idx, 'sku_id'], message: `${m.modelName} is not on ${ref} — it needs its own prescription` });
      } else if (!rx.is_dangerous_drug && m.pieces > item.quantity_remaining) {
        issues.push({
          code: 'RX_OVER_REMAINING',
          path: ['items', idx, 'quantity'],
          message: `${m.modelName}: ${m.pieces} piece(s) in this sale, but only ${Math.max(item.quantity_remaining, 0)} of the ${item.quantity_prescribed} prescribed on ${ref} are left`,
        });
      } else if (rx.is_dangerous_drug && m.pieces > item.quantity_prescribed) {
        issues.push({ code: 'RX_OVER_PRESCRIBED', path: ['items', idx, 'quantity'], message: `${m.modelName}: ${m.pieces} piece(s) in this sale, but ${ref} prescribes ${item.quantity_prescribed}` });
      }
    }
    return issues;
  }

  // ---- a new prescription ----
  const doctor = d.doctorId === null ? null : (p.doctors.find((x) => x.id === d.doctorId) ?? null);
  if (d.doctorId === null) {
    issues.push({ code: 'RX_DOCTOR_REQUIRED', path: ['prescription', 'doctor_id'], message: DOCTOR_REQUIRED_MESSAGE });
  } else if (!doctor) {
    // Gone from the refreshed list = deactivated (or never this company's): it can't be picked any more.
    issues.push({ code: 'RX_DOCTOR_NOT_FOUND', path: ['prescription', 'doctor_id'], message: "This doctor is not on your company's doctors list — choose another doctor" });
  } else if (!doctor.usable || !filled(doctor.license_number)) {
    issues.push({ code: 'RX_DOCTOR_NO_PRC', path: ['prescription', 'doctor_id'], message: `${doctor.name} has no PRC licence number on file — fill it in first` });
  }

  const date = d.date.trim();
  if (date === '') {
    issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'prescription_date'], message: 'Enter the prescription date' });
  } else if (!isYmd(date)) {
    issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'prescription_date'], message: 'Enter the prescription date as YYYY-MM-DD' });
  } else {
    const dp = prescriptionDateProblem(date, p.today, anyDangerous);
    if (dp) issues.push({ code: dp.code, path: ['prescription', 'prescription_date'], message: dp.message });
  }

  models.forEach((m, i) => {
    const raw = d.quantities[m.modelId];
    if (!filled(raw)) {
      issues.push({ code: 'RX_ITEM_QUANTITY_MISSING', path: ['prescription', 'items', i, 'quantity_prescribed'], message: `Enter the quantity prescribed for ${m.modelName}` });
      return;
    }
    const q = parsePieces(raw);
    if (q === null) {
      issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'items', i, 'quantity_prescribed'], message: `${m.modelName}: the quantity prescribed must be a whole number of pieces (1 or more)` });
    } else if (m.pieces > q) {
      issues.push({ code: 'RX_OVER_PRESCRIBED', path: ['prescription', 'items', i, 'quantity_prescribed'], message: `${m.modelName}: ${m.pieces} piece(s) in this sale, but only ${q} prescribed` });
    }
  });

  if (doctor && doctor.ptr_number === null && d.ptr.trim().length > MAX_PTR) {
    issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'prescriber_ptr_no'], message: `The PTR number must be ${MAX_PTR} characters or fewer` });
  }
  if (anyDangerous) {
    const s2 = doctor?.s2_license_number ?? d.s2.trim();
    if (!filled(s2)) {
      issues.push({ code: 'RX_DD_S2_REQUIRED', path: ['prescription', 'prescriber_s2_license_no'], message: "A dangerous drug needs the prescriber's S2 licence number" });
    } else if (s2.length > MAX_S2) {
      issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'prescriber_s2_license_no'], message: `The S2 licence number must be ${MAX_S2} characters or fewer` });
    }
    const serial = d.serial.trim();
    if (serial === '') {
      issues.push({ code: 'RX_DD_SERIAL_REQUIRED', path: ['prescription', 'serial_number'], message: "A dangerous drug needs the prescription form's serial number" });
    } else if (serial.length > MAX_SERIAL) {
      issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'serial_number'], message: `The serial number must be ${MAX_SERIAL} characters or fewer` });
    }
    const address = d.patientAddress.trim();
    if (address === '' && !p.patient.hasAddress) {
      issues.push({ code: 'RX_DD_ADDRESS_REQUIRED', path: ['prescription', 'patient_address'], message: "A dangerous drug needs the patient's address" });
    } else if (address.length > MAX_ADDRESS) {
      issues.push({ code: 'RX_INCOMPLETE', path: ['prescription', 'patient_address'], message: `The patient's address must be ${MAX_ADDRESS} characters or fewer` });
    }
  }
  return issues;
}

// ---- the payload ----------------------------------------------------------------------------------------------------

/** SalePayload.prescription for the cart (null = no Rx line, or no draft). Run `localRxIssues` first — this maps the
 * draft as it stands (an unreadable quantity item is left out). */
export function prescriptionPayload(draft: RxDraft | null, lines: readonly RxLineInput[], doctors: readonly PosPrescriptionDoctor[]): SalePrescriptionPayload | null {
  const { models } = rxModelsOf(lines);
  if (!draft || models.length === 0) return null;
  if (draft.mode === 'FILL') return { prescription_id: draft.prescription.id };
  const doctor = draft.doctorId === null ? null : (doctors.find((x) => x.id === draft.doctorId) ?? null);
  const dangerous = models.some((m) => m.dangerous);
  const out: SalePrescriptionPayload = {
    doctor_id: draft.doctorId,
    prescription_date: draft.date.trim() || null,
    items: models.flatMap((m) => {
      const q = parsePieces(draft.quantities[m.modelId]);
      return q === null ? [] : [{ product_model_id: m.modelId, quantity_prescribed: q }];
    }),
  };
  // PTR / S2 come from the doctor when on file; typed only when the doctor's is null (contract).
  const ptr = draft.ptr.trim();
  if (doctor && doctor.ptr_number === null && ptr !== '') out.prescriber_ptr_no = ptr;
  if (dangerous) {
    const s2 = draft.s2.trim();
    if (doctor && doctor.s2_license_number === null && s2 !== '') out.prescriber_s2_license_no = s2;
    const serial = draft.serial.trim();
    if (serial !== '') out.serial_number = serial;
    const address = draft.patientAddress.trim();
    if (address !== '') out.patient_address = address;
  }
  return out;
}

/** POST /pos/prescriptions/check body for the cart as the sale will send it. */
export function prescriptionCheckRequest(input: {
  client: SaleClientPayload | null;
  statutory: SaleStatutoryPayload | null;
  lines: readonly RxLineInput[];
  prescription: SalePrescriptionPayload | null;
}): PosPrescriptionCheckRequest {
  const s = input.statutory;
  return {
    client: input.client,
    statutory_discount: s ? { first_name: s.first_name, last_name: s.last_name, ...(s.address ? { address: s.address } : {}) } : null,
    lines: input.lines.map((l) => ({ sku_id: l.skuId, quantity: l.quantity })),
    prescription: input.prescription,
  };
}

/** The doctor picker's search: name, clinic, PRC or specialty contain every typed word (case-insensitive). Empty query →
 * the first `limit` A→Z. */
export function searchDoctors(items: readonly PosPrescriptionDoctor[], query: string, limit = 50): PosPrescriptionDoctor[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: PosPrescriptionDoctor[] = [];
  for (const d of items) {
    if (words.length > 0) {
      const hay = [d.name, d.clinic, d.license_number, d.specialty].filter(Boolean).join(' ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- issues on screen -----------------------------------------------------------------------------------------------

export type RxField = 'client' | 'open' | 'doctor' | 'date' | 'quantity' | 'ptr' | 's2' | 'serial' | 'address' | 'general';

/** Which input an issue belongs on (server `path` or local) and, for a quantity, which model (null = not known). */
export function rxIssueField(issue: Pick<PosRxIssue, 'path'>, lines: readonly RxLineInput[]): { field: RxField; modelId: number | null } {
  const [a, b, c] = issue.path;
  if (a === 'client_id') return { field: 'client', modelId: null };
  if (a === 'items' && typeof b === 'number') return { field: 'quantity', modelId: lines[b]?.modelId ?? null };
  if (a !== 'prescription') return { field: 'general', modelId: null };
  switch (b) {
    case 'prescription_id':
      return { field: 'open', modelId: null };
    case 'doctor_id':
      return { field: 'doctor', modelId: null };
    case 'prescription_date':
      return { field: 'date', modelId: null };
    case 'prescriber_ptr_no':
      return { field: 'ptr', modelId: null };
    case 'prescriber_s2_license_no':
      return { field: 's2', modelId: null };
    case 'serial_number':
      return { field: 'serial', modelId: null };
    case 'patient_address':
      return { field: 'address', modelId: null };
    case 'items': {
      const { models } = rxModelsOf(lines);
      return { field: 'quantity', modelId: typeof c === 'number' ? (models[c]?.modelId ?? null) : null };
    }
    default:
      return { field: 'general', modelId: null };
  }
}

/** The sync log's plain words for a PRESCRIPTION_ISSUE code (the server's message is shown under it). */
export function rxIssueTitle(code: PosRxIssueCode | string | undefined): string {
  switch (code) {
    case 'RX_CLIENT_NOT_NAMED':
      return 'Prescription item sold without a named patient';
    case 'RX_REQUIRED':
      return 'Prescription item sold without a prescription';
    case 'RX_NOT_NEEDED':
      return 'Prescription entered but not needed';
    case 'RX_INCOMPLETE':
      return 'Prescription details incomplete';
    case 'RX_UNREADABLE':
      return 'Prescription could not be read — sale recorded without it';
    case 'RX_TOO_MANY_PIECES':
      return 'Too many pieces on one line';
    case 'RX_NOT_FOUND':
      return 'Prescription not found';
    case 'RX_OTHER_CLIENT':
      return 'Prescription belongs to another client';
    case 'RX_DATE_AFTER_SALE':
      return 'Prescription dated after the sale';
    case 'RX_EXPIRED':
      return 'Prescription too old';
    case 'RX_NOT_DANGEROUS_DRUGS':
      return 'Dangerous drug filled on a non-S2 prescription';
    case 'RX_DD_ALREADY_FILLED':
      return 'Dangerous-drugs prescription already filled';
    case 'RX_ITEM_NOT_ON_PRESCRIPTION':
      return 'Item not on the prescription';
    case 'RX_OVER_REMAINING':
      return 'More pieces than are left on the prescription';
    case 'RX_OVER_PRESCRIBED':
      return 'More pieces than prescribed';
    case 'RX_ITEM_QUANTITY_MISSING':
      return 'Quantity prescribed missing';
    case 'RX_ITEM_NOT_RX_LINE':
      return 'Prescription lists an item that is not prescription-only';
    case 'RX_DOCTOR_REQUIRED':
      return 'No doctor chosen';
    case 'RX_DOCTOR_NOT_FOUND':
      return 'Doctor not on the doctors list';
    case 'RX_DOCTOR_INACTIVE':
      return 'Doctor no longer active';
    case 'RX_DOCTOR_NO_PRC':
      return 'Doctor has no PRC licence on file';
    case 'RX_PRESCRIBER_MISSING':
      return 'Prescriber details missing';
    case 'RX_DD_S2_REQUIRED':
      return 'Dangerous drug: S2 licence missing';
    case 'RX_DD_SERIAL_REQUIRED':
      return 'Dangerous drug: form serial number missing';
    case 'RX_DD_ADDRESS_REQUIRED':
      return "Dangerous drug: patient's address missing";
    case 'RX_DD_SERIAL_TAKEN':
      return 'Dangerous-drugs serial number already on file';
    default:
      return 'Prescription issue';
  }
}
