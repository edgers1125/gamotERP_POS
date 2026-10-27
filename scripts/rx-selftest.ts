// Self-test of the Rx step's pure rules (src/sale/prescription.ts) — no device, no server:
//   * Rx lines and pieces per model (quantity × pack_quantity, summed per model; a dangerous drug is always Rx; a SKU with
//     no model can't go on a prescription);
//   * the named-client rule (existing / registered new client; never "No client details");
//   * the OFFLINE local checks of a NEW prescription (doctor from the cache: missing / gone / no PRC; date ≤ today and
//     ≤ 180 days old, dangerous drugs 30; quantity prescribed ≥ the cart's pieces per model; dangerous drugs: S2 (doctor's
//     or typed), form serial, patient address (typed, on record, or on the Senior/PWD card)) and of FILLING an open
//     prescription fetched online (other client, expired, not S2, DD already filled, model not on it, over remaining);
//   * the payload mapping (doctor_id + date + items; PTR / S2 only when the doctor has none; serial / address only for
//     dangerous drugs; never prescriber_name; fill = { prescription_id } only) and the check request;
//   * issue → field mapping for the server's paths, the sync-log titles, the doctor search.
// GamotERP docs/plans/pos-rx-step.md "Offline rules for the app" + contract "Prescriptions — the POS Rx step".
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/rx-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import type { PosClient, PosOpenPrescription, PosPrescriptionDoctor, PosRxIssue } from '@pos-api/contract';

import type { SaleClient } from '../src/sale/cart';
import {
  cartNeedsRx,
  localRxIssues,
  newRxDraft,
  prescriptionCheckRequest,
  prescriptionPayload,
  rxIssueField,
  rxIssueTitle,
  rxModelsOf,
  rxPatientOf,
  searchDoctors,
  withCartModels,
  type RxDraft,
  type RxLineInput,
  type RxNewDraft,
  type RxPatient,
} from '../src/sale/prescription';
import { EMPTY_STATUTORY, type StatutoryDraft } from '../src/sale/statutory';

declare const process: { exitCode?: number };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}
const codes = (issues: PosRxIssue[]) => issues.map((i) => i.code);

const TODAY = '2026-10-27';

// ---- cart lines ---------------------------------------------------------------------------------------------------
const line = (p: Partial<RxLineInput> & { skuId: number }): RxLineInput => ({
  name: `SKU ${p.skuId}`,
  quantity: 1,
  packQuantity: 1,
  modelId: null,
  modelName: '',
  rxRequired: false,
  dangerous: false,
  ...p,
});
const PARA = line({ skuId: 1, name: 'Paracetamol 500mg', modelId: 10, modelName: 'Paracetamol 500mg' }); // not Rx
const AMOX_10 = line({ skuId: 2, name: 'Amoxicillin 500mg x10', quantity: 2, packQuantity: 10, modelId: 20, modelName: 'Amoxicillin 500mg', rxRequired: true });
const AMOX_1 = line({ skuId: 3, name: 'Amoxicillin 500mg x1', quantity: 3, packQuantity: 1, modelId: 20, modelName: 'Amoxicillin 500mg', rxRequired: true });
const MORPH = line({ skuId: 4, name: 'Morphine 10mg x10', quantity: 1, packQuantity: 10, modelId: 30, modelName: 'Morphine 10mg', dangerous: true }); // DD, rx flag absent
const NOMODEL = line({ skuId: 5, name: 'Loose Rx', rxRequired: true });

check('no Rx line → not needed', !cartNeedsRx([PARA]));
check('rx_required → needed', cartNeedsRx([PARA, AMOX_10]));
check('dangerous drug without rx flag → needed', cartNeedsRx([MORPH]));
{
  const { models, noModel } = rxModelsOf([PARA, AMOX_10, AMOX_1, MORPH, NOMODEL]);
  check('two Rx models', models.length === 2, models);
  check('pieces summed per model (2×10 + 3×1 = 23)', models[0]?.modelId === 20 && models[0].pieces === 23 && models[0].lineIndexes.join() === '1,2', models[0]);
  check('DD model flagged', models[1]?.modelId === 30 && models[1].dangerous && models[1].pieces === 10);
  check('Rx SKU without a model listed apart', noModel.join() === '4');
}
check('no-model Rx line → RX_INCOMPLETE on its line', (() => {
  const i = localRxIssues({ lines: [NOMODEL], patient: { named: true, clientId: 1, hasAddress: false }, draft: null, doctors: [], today: TODAY });
  return i[0]?.code === 'RX_INCOMPLETE' && i[0].path.join() === 'items,0,sku_id';
})());

// ---- the patient --------------------------------------------------------------------------------------------------
const client = (p: Partial<PosClient> = {}): PosClient => ({
  id: 77,
  first_name: 'Juan',
  middle_name: null,
  last_name: 'Dela Cruz',
  phone_number: '09171234567',
  statutory_type: null,
  statutory_id_number: null,
  statutory_id_issuer: null,
  id_expiry_date: null,
  date_of_birth: null,
  sex: null,
  has_address: false,
  ...p,
});
const EXISTING: SaleClient = { kind: 'EXISTING', client: client() };
check('existing named client', JSON.stringify(rxPatientOf(EXISTING, null)) === JSON.stringify({ named: true, clientId: 77, hasAddress: false }));
check('existing client without last name → not named', !rxPatientOf({ kind: 'EXISTING', client: client({ last_name: null }) }, null).named);
check('existing client address on record', rxPatientOf({ kind: 'EXISTING', client: client({ has_address: true }) }, null).hasAddress);
check('new registered client named', rxPatientOf({ kind: 'NEW', clientUuid: 'u', firstName: 'Ana', middleName: '', lastName: 'Reyes', phone: '0917' }, null).named);
check('walk-in with names → still not named (Rx needs the patient as client)', !rxPatientOf({ kind: 'WALK_IN', clientUuid: 'u', firstName: 'Ana', lastName: 'Reyes' }, null).named);
check('unset → not named', !rxPatientOf({ kind: 'UNSET' }, null).named);
{
  const card: StatutoryDraft = {
    ...EMPTY_STATUTORY,
    address: { ...EMPTY_STATUTORY.address, line1: '1 Main St', city: 'Quezon City', province: 'Metro Manila', postalCode: '1100' },
  };
  check('complete Senior/PWD card address counts for a new client', rxPatientOf({ kind: 'NEW', clientUuid: 'u', firstName: 'A', middleName: '', lastName: 'B', phone: '' }, card).hasAddress);
  const partial: StatutoryDraft = { ...EMPTY_STATUTORY, address: { ...EMPTY_STATUTORY.address, line1: '1 Main St' } };
  check('incomplete card address does not', !rxPatientOf({ kind: 'NEW', clientUuid: 'u', firstName: 'A', middleName: '', lastName: 'B', phone: '' }, partial).hasAddress);
}

// ---- doctors ------------------------------------------------------------------------------------------------------
const doc = (p: Partial<PosPrescriptionDoctor> & { id: number; name: string }): PosPrescriptionDoctor => ({
  license_number: '0123456',
  clinic: 'Clinic',
  specialty: null,
  ptr_number: 'PTR-1',
  s2_license_number: 'S2-1',
  usable: true,
  missing: [],
  ...p,
});
const DR_A = doc({ id: 1, name: 'Dr. Ana Santos', clinic: 'Makati Med', specialty: 'Pediatrics' });
const DR_NO_PTR_S2 = doc({ id: 2, name: 'Dr. Ben Cruz', ptr_number: null, s2_license_number: null, missing: ['ptr_number', 's2_license_number'] });
const DR_NO_PRC = doc({ id: 3, name: 'Dr. Carla Lim', license_number: null, usable: false, missing: ['license_number'] });
const DOCTORS = [DR_A, DR_NO_PTR_S2, DR_NO_PRC];

check('search by name', searchDoctors(DOCTORS, 'ana').map((d) => d.id).join() === '1');
check('search by clinic + specialty words', searchDoctors(DOCTORS, 'makati pedia').map((d) => d.id).join() === '1');
check('search by PRC', searchDoctors(DOCTORS, '0123').length === 2);
check('empty search → first N', searchDoctors(DOCTORS, '', 2).length === 2);

// ---- a NEW prescription (offline local checks) --------------------------------------------------------------------
const NAMED: RxPatient = { named: true, clientId: 77, hasAddress: false };
const RX_CART = [PARA, AMOX_10, AMOX_1];
const DD_CART = [PARA, MORPH];
const draftFor = (lines: RxLineInput[], p: Partial<RxNewDraft> = {}): RxNewDraft => ({ ...newRxDraft(rxModelsOf(lines).models, TODAY), ...p });
const issuesOf = (lines: RxLineInput[], draft: RxDraft | null, patient: RxPatient = NAMED, today = TODAY) =>
  localRxIssues({ lines, patient, draft, doctors: DOCTORS, today });

check('no Rx line → no issues even with a draft', issuesOf([PARA], draftFor(RX_CART)).length === 0);
check('no draft → RX_REQUIRED', codes(issuesOf(RX_CART, null)).join() === 'RX_REQUIRED');
check('RX_REQUIRED wording', issuesOf(RX_CART, null)[0]?.message === 'Amoxicillin 500mg is prescription-only — enter the prescription');
check('not named + no draft → both', codes(issuesOf(RX_CART, null, { named: false, clientId: null, hasAddress: false })).join() === 'RX_CLIENT_NOT_NAMED,RX_REQUIRED');
check('draft pre-fills the cart pieces', newRxDraft(rxModelsOf(RX_CART).models, TODAY).quantities[20] === '23');
check('no doctor → RX_DOCTOR_REQUIRED', codes(issuesOf(RX_CART, draftFor(RX_CART))).join() === 'RX_DOCTOR_REQUIRED');
check('good new prescription → none', issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1 })).length === 0, issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1 })));
check('doctor gone from the cache → RX_DOCTOR_NOT_FOUND', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 99 }))).join() === 'RX_DOCTOR_NOT_FOUND');
check('doctor without PRC → RX_DOCTOR_NO_PRC', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 3 }))).join() === 'RX_DOCTOR_NO_PRC');
check('no date → RX_INCOMPLETE on the date', (() => {
  const i = issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, date: '' }));
  return i.length === 1 && i[0]!.code === 'RX_INCOMPLETE' && i[0]!.path.join() === 'prescription,prescription_date';
})());
check('bad date → RX_INCOMPLETE', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, date: '2026-02-30' }))).join() === 'RX_INCOMPLETE');
check('date after the sale day → RX_DATE_AFTER_SALE', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, date: '2026-10-28' }))).join() === 'RX_DATE_AFTER_SALE');
check('180 days old → fine', issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, date: '2026-04-30' })).length === 0);
check('181 days old → RX_EXPIRED', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, date: '2026-04-29' }))).join() === 'RX_EXPIRED');
check('missing quantity → RX_ITEM_QUANTITY_MISSING', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, quantities: { 20: ' ' } }))).join() === 'RX_ITEM_QUANTITY_MISSING');
check('fewer pieces prescribed than sold → RX_OVER_PRESCRIBED', (() => {
  const i = issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, quantities: { 20: '22' } }));
  return codes(i).join() === 'RX_OVER_PRESCRIBED' && i[0]!.message === 'Amoxicillin 500mg: 23 piece(s) in this sale, but only 22 prescribed';
})());
check('more prescribed than sold → fine (partial fill)', issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, quantities: { 20: '60' } })).length === 0);
check('0 / decimal quantity → RX_INCOMPLETE', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, quantities: { 20: '0' } }))).join() === 'RX_INCOMPLETE' && codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 1, quantities: { 20: '2.5' } }))).join() === 'RX_INCOMPLETE');
check('PTR too long → RX_INCOMPLETE (doctor without PTR)', codes(issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 2, ptr: 'x'.repeat(31) }))).join() === 'RX_INCOMPLETE');

// Dangerous drugs.
check('DD: 30-day window', codes(issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 1, date: '2026-09-26', serial: 'A1', patientAddress: 'x' }))).join() === 'RX_EXPIRED');
check('DD: 30 days old fine', issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 1, date: '2026-09-27', serial: 'A1', patientAddress: 'x' })).length === 0);
check('DD: serial + address required', codes(issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 1 }))).join() === 'RX_DD_SERIAL_REQUIRED,RX_DD_ADDRESS_REQUIRED');
check('DD: address on record is enough', issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 1, serial: 'A1' }), { ...NAMED, hasAddress: true }).length === 0);
check('DD: doctor without S2 → S2 must be typed', codes(issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 2, serial: 'A1', patientAddress: 'x' }))).join() === 'RX_DD_S2_REQUIRED');
check('DD: typed S2 accepted', issuesOf(DD_CART, draftFor(DD_CART, { doctorId: 2, s2: 'S2-99', serial: 'A1', patientAddress: 'x' })).length === 0);
check('not DD: serial / address not asked', issuesOf(RX_CART, draftFor(RX_CART, { doctorId: 2 })).length === 0);

// ---- FILL an open prescription (fetched online during this sale) ---------------------------------------------------
const open = (p: Partial<PosOpenPrescription> = {}): PosOpenPrescription => ({
  id: 501,
  reference: 'RX-501',
  status: 'PARTIALLY_FILLED',
  is_dangerous_drug: false,
  prescriber_name: 'Dr. Ana Santos',
  prescription_date: '2026-10-01',
  valid_until: '2027-03-30',
  items: [{ product_model_id: 20, model_name: 'Amoxicillin 500mg', is_dangerous_drug: false, quantity_prescribed: 60, quantity_filled: 30, quantity_remaining: 30 }],
  ...p,
});
const fill = (rx: PosOpenPrescription, clientId = 77): RxDraft => ({ mode: 'FILL', prescription: rx, clientId });
check('fill within remaining → none', issuesOf(RX_CART, fill(open())).length === 0);
check('fill: another client → RX_OTHER_CLIENT', codes(issuesOf(RX_CART, fill(open(), 78))).join() === 'RX_OTHER_CLIENT');
check('fill: new client (no id) → RX_OTHER_CLIENT', codes(issuesOf(RX_CART, fill(open()), { named: true, clientId: null, hasAddress: false })).join() === 'RX_OTHER_CLIENT');
check('fill: over remaining → RX_OVER_REMAINING', (() => {
  const rx = open({ items: [{ ...open().items[0]!, quantity_filled: 40, quantity_remaining: 20 }] });
  const i = issuesOf(RX_CART, fill(rx));
  return codes(i).join() === 'RX_OVER_REMAINING' && i[0]!.message === 'Amoxicillin 500mg: 23 piece(s) in this sale, but only 20 of the 60 prescribed on RX-501 are left' && i[0]!.path.join() === 'items,1,quantity';
})());
check('fill: model not on it → RX_ITEM_NOT_ON_PRESCRIPTION', codes(issuesOf([...RX_CART, line({ skuId: 9, modelId: 90, modelName: 'Cefalexin', rxRequired: true })], fill(open()))).join() === 'RX_ITEM_NOT_ON_PRESCRIPTION');
check('fill: too old → RX_EXPIRED with the reference', (() => {
  const i = issuesOf(RX_CART, fill(open({ prescription_date: '2026-01-01' })));
  return codes(i).join() === 'RX_EXPIRED' && i[0]!.message.startsWith('RX-501: ');
})());
check('fill: DD in cart, ordinary prescription → RX_NOT_DANGEROUS_DRUGS', codes(issuesOf(DD_CART, fill(open({ items: [{ ...open().items[0]!, product_model_id: 30 }] })))).join() === 'RX_NOT_DANGEROUS_DRUGS');
check('fill: DD prescription already filled → RX_DD_ALREADY_FILLED', (() => {
  const rx = open({ is_dangerous_drug: true, prescription_date: '2026-10-20', items: [{ product_model_id: 30, model_name: 'Morphine 10mg', is_dangerous_drug: true, quantity_prescribed: 20, quantity_filled: 10, quantity_remaining: 0 }] });
  return codes(issuesOf(DD_CART, fill(rx))).join() === 'RX_DD_ALREADY_FILLED';
})());
check('fill: DD never filled, within prescribed → none', (() => {
  const rx = open({ is_dangerous_drug: true, prescription_date: '2026-10-20', items: [{ product_model_id: 30, model_name: 'Morphine 10mg', is_dangerous_drug: true, quantity_prescribed: 10, quantity_filled: 0, quantity_remaining: 10 }] });
  return issuesOf(DD_CART, fill(rx)).length === 0;
})());

// ---- the cart changes after the draft -----------------------------------------------------------------------------
{
  const d = draftFor([AMOX_10], { quantities: { 20: '50' } });
  const after = withCartModels(d, rxModelsOf([AMOX_10, MORPH]).models);
  check('cart change keeps typed quantity, pre-fills a new model', after.quantities[20] === '50' && after.quantities[30] === '10');
  check('removed model dropped', !(30 in withCartModels(after, rxModelsOf([AMOX_10]).models).quantities));
  check('unchanged cart → same draft object', withCartModels(d, rxModelsOf([AMOX_10]).models) === d);
}

// ---- payload mapping ----------------------------------------------------------------------------------------------
{
  const p = prescriptionPayload(draftFor(RX_CART, { doctorId: 1, ptr: 'typed', s2: 'typed', serial: 'x', patientAddress: 'y' }), RX_CART, DOCTORS);
  check(
    'new, doctor with PTR/S2, not DD → doctor_id + date + items only',
    JSON.stringify(p) === JSON.stringify({ doctor_id: 1, prescription_date: TODAY, items: [{ product_model_id: 20, quantity_prescribed: 23 }] }),
    p,
  );
  check('never prescriber_name / prc / clinic', p !== null && !('prescriber_name' in p) && !('prescriber_prc_license_no' in p) && !('prescriber_clinic' in p));
}
{
  const p = prescriptionPayload(draftFor(DD_CART, { doctorId: 2, ptr: ' PTR-9 ', s2: 'S2-9', serial: ' SN-1 ', patientAddress: ' 1 Main St ' }), DD_CART, DOCTORS);
  check('DD, doctor without PTR/S2 → typed PTR + S2 + serial + address (trimmed)', JSON.stringify(p) === JSON.stringify({
    doctor_id: 2,
    prescription_date: TODAY,
    items: [{ product_model_id: 30, quantity_prescribed: 10 }],
    prescriber_ptr_no: 'PTR-9',
    prescriber_s2_license_no: 'S2-9',
    serial_number: 'SN-1',
    patient_address: '1 Main St',
  }), p);
}
{
  const p = prescriptionPayload(draftFor(DD_CART, { doctorId: 1, s2: 'ignored', serial: 'SN-1' }), DD_CART, DOCTORS);
  check('DD, doctor with S2 → typed S2 not sent; blank address not sent', p !== null && !('prescriber_s2_license_no' in p) && !('patient_address' in p) && p.serial_number === 'SN-1');
}
check('fill → { prescription_id } only', JSON.stringify(prescriptionPayload(fill(open()), RX_CART, DOCTORS)) === JSON.stringify({ prescription_id: 501 }));
check('no Rx line → null', prescriptionPayload(draftFor(RX_CART, { doctorId: 1 }), [PARA], DOCTORS) === null);
check('no draft → null', prescriptionPayload(null, RX_CART, DOCTORS) === null);
{
  const req = prescriptionCheckRequest({
    client: { client_id: 77 },
    statutory: { type: 'SENIOR', id_number: '1', first_name: 'Juan', middle_name: null, last_name: 'Dela Cruz', id_issuer: null, id_expiry_date: null, birth_date: null, address: null },
    lines: RX_CART,
    prescription: { prescription_id: 501 },
  });
  check('check request: all lines in cart order', JSON.stringify(req.lines) === JSON.stringify([{ sku_id: 1, quantity: 1 }, { sku_id: 2, quantity: 2 }, { sku_id: 3, quantity: 3 }]));
  check('check request: statutory names, no null address', JSON.stringify(req.statutory_discount) === JSON.stringify({ first_name: 'Juan', last_name: 'Dela Cruz' }));
  check('check request: no statutory → null', prescriptionCheckRequest({ client: null, statutory: null, lines: [], prescription: null }).statutory_discount === null);
}

// ---- issues on screen / sync log ----------------------------------------------------------------------------------
check('server path items,1,quantity → quantity of model 20', JSON.stringify(rxIssueField({ path: ['items', 1, 'quantity'] }, RX_CART)) === JSON.stringify({ field: 'quantity', modelId: 20 }));
check('prescription.items.0 → first Rx model', rxIssueField({ path: ['prescription', 'items', 0, 'quantity_prescribed'] }, RX_CART).modelId === 20);
check('serial path → serial', rxIssueField({ path: ['prescription', 'serial_number'] }, RX_CART).field === 'serial');
check('client_id → client', rxIssueField({ path: ['client_id'] }, RX_CART).field === 'client');
check('unknown path → general', rxIssueField({ path: ['prescription'] }, RX_CART).field === 'general');
check('sync log title', rxIssueTitle('RX_DD_SERIAL_TAKEN') === 'Dangerous-drugs serial number already on file' && rxIssueTitle(undefined) === 'Prescription issue');

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
