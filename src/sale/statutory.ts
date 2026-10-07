// Senior Citizen / PWD discount (RA 9994 / RA 10754) — rules from docs/plans/pos-terminals-payments-scpwd.md
// (REVISION 2: the card lives on the client). The 20% / VAT-exempt arithmetic is the shared pricing code's; this file
// only holds the draft the cashier fills in and the checks the server would otherwise refuse (or flag) at sync.
import { businessToday } from '@shared/business-day';
import { normalizePhone } from '@shared/phone';
import type { PosClient, SaleStatutoryPayload } from '@pos-api/contract';

export type StatutoryType = 'SENIOR' | 'PWD';
export type ClientSex = NonNullable<SaleStatutoryPayload['sex']>;

// The cardholder's optional address — all-or-nothing, like the web (backend addressInputSchema; country defaults to PH).
export interface StatutoryAddressDraft {
  line1: string;
  line2: string;
  barangay: string;
  city: string;
  province: string;
  region: string;
  postalCode: string;
}

export interface StatutoryDraft {
  type: StatutoryType;
  idNumber: string;
  firstName: string;
  middleName: string;
  lastName: string;
  idIssuer: string;
  birthDate: string; // YYYY-MM-DD or ''
  expiryDate: string; // YYYY-MM-DD or '' — PWD only (senior IDs don't expire)
  // Optional extras for the cardholder's client record (SaleStatutoryPayload phone_number / address / sex). Sent only
  // when filled; a new client gets them, an existing client only has what it lacks filled (never overwritten).
  phone: string;
  sex: ClientSex | '';
  address: StatutoryAddressDraft;
}

export const EMPTY_ADDRESS: StatutoryAddressDraft = { line1: '', line2: '', barangay: '', city: '', province: '', region: '', postalCode: '' };

export const EMPTY_STATUTORY: StatutoryDraft = {
  type: 'SENIOR',
  idNumber: '',
  firstName: '',
  middleName: '',
  lastName: '',
  idIssuer: '',
  birthDate: '',
  expiryDate: '',
  phone: '',
  sex: '',
  address: EMPTY_ADDRESS,
};

// The address fields a complete address needs (backend addressInputSchema), with their labels.
const REQUIRED_ADDRESS_FIELDS: [keyof StatutoryAddressDraft, string][] = [
  ['line1', 'address line 1'],
  ['city', 'city'],
  ['province', 'province'],
  ['postalCode', 'postal code'],
];

/** Any address field typed in (an address is all-or-nothing: untouched, or complete). */
export function addressStarted(a: StatutoryAddressDraft): boolean {
  return Object.values(a).some((v) => v.trim() !== '');
}

export function missingAddressFields(a: StatutoryAddressDraft): string[] {
  if (!addressStarted(a)) return [];
  return REQUIRED_ADDRESS_FIELDS.filter(([k]) => a[k].trim() === '').map(([, label]) => label);
}

/**
 * Which extras are worth asking for: everything for a new client (null); for an existing client only what their
 * record lacks (the server ignores the rest). A client cached before sex/has_address existed → offered.
 */
export function statutoryExtrasOffered(client: PosClient | null): { phone: boolean; address: boolean; sex: boolean } {
  if (!client) return { phone: true, address: true, sex: true };
  return { phone: !client.phone_number, address: client.has_address !== true, sex: !client.sex };
}

/** The draft with the extras the client doesn't need cleared (so they're never sent). */
export function withOfferedExtras(d: StatutoryDraft, client: PosClient | null): StatutoryDraft {
  const offered = statutoryExtrasOffered(client);
  return {
    ...d,
    phone: offered.phone ? d.phone : '',
    sex: offered.sex ? d.sex : '',
    address: offered.address ? d.address : EMPTY_ADDRESS,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function statutoryTypeLabel(type: StatutoryType): string {
  return type === 'PWD' ? 'PWD' : 'Senior Citizen';
}

/** How the server stores and compares ID numbers (lib/statutory-client.ts normalizeStatutoryIdNumber). */
export function normalizeIdNumber(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** Expired = expiry before today in Manila (expiring today is still valid) — lib/business-day.ts decides "today". */
export function isIdExpired(expiry: string): boolean {
  return expiry !== '' && expiry < businessToday();
}

export function formatDateOnly(value: string): string {
  if (!isValidDate(value)) return value;
  const [y, m, d] = value.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m! - 1]} ${d}, ${y}`;
}

/** Why the card can't be used yet (null = ready). */
export function statutoryProblem(d: StatutoryDraft): string | null {
  if (d.idNumber.trim() === '') return 'Enter the Senior/PWD ID number.';
  if (d.idNumber.trim().length > 64) return 'The ID number must be 64 characters or fewer.';
  if (d.firstName.trim() === '' || d.lastName.trim() === '') return 'Enter the cardholder’s first and last name.';
  if (d.birthDate !== '' && !isValidDate(d.birthDate)) return 'Use the date format YYYY-MM-DD for the birth date.';
  if (d.birthDate !== '' && d.birthDate > businessToday()) return 'The birth date can’t be in the future.';
  if (d.type === 'PWD') {
    if (d.expiryDate === '') return 'Enter the PWD ID’s expiry date.';
    if (!isValidDate(d.expiryDate)) return 'Use the date format YYYY-MM-DD for the expiry date.';
    if (isIdExpired(d.expiryDate)) return `This PWD ID expired on ${formatDateOnly(d.expiryDate)} — update the card details.`;
  }
  if (normalizePhone(d.phone).length > 30) return 'The phone number must be 30 characters or fewer.';
  const missing = missingAddressFields(d.address);
  if (missing.length > 0) return `Finish the client’s address (${missing.join(', ')}) or clear it.`;
  return null;
}

export function clientHasStatutory(c: PosClient | null | undefined): c is PosClient & { statutory_type: StatutoryType; statutory_id_number: string } {
  return !!c && !!c.statutory_type && !!c.statutory_id_number;
}

/**
 * Whether a client's card on record can be applied as-is when they're picked: a Senior Citizen ID never expires; a PWD
 * ID needs an expiry date that hasn't passed (Manila today counts as valid). Returns why not, or null when usable.
 */
export function clientStatutoryBlock(c: PosClient): string | null {
  if (!clientHasStatutory(c) || c.statutory_type !== 'PWD') return null;
  const expiry = (c.id_expiry_date ?? '').slice(0, 10);
  if (expiry === '') return 'Their PWD ID has no expiry date on record — open Senior / PWD to enter it.';
  if (isIdExpired(expiry)) return `Their PWD ID expired on ${formatDateOnly(expiry)} — the discount wasn’t applied. Open Senior / PWD if they have a renewed card.`;
  return null;
}

/** The server refuses a sale whose existing client is on record with a DIFFERENT card (mirrors lib/statutory-client.ts). */
export function statutoryClientConflict(d: StatutoryDraft, client: PosClient | null): string | null {
  if (!clientHasStatutory(client) || d.idNumber.trim() === '') return null;
  if (client.statutory_type === d.type && normalizeIdNumber(client.statutory_id_number) === normalizeIdNumber(d.idNumber)) return null;
  return `${clientName(client)} is on record with ${statutoryTypeLabel(client.statutory_type)} ID ${client.statutory_id_number} — use that card, or choose “New client” if this card isn’t theirs.`;
}

/** A draft filled from a client's record (picking a Senior/PWD client pre-fills the card). */
export function draftFromClient(c: PosClient, base: StatutoryDraft = EMPTY_STATUTORY): StatutoryDraft {
  return {
    type: c.statutory_type ?? base.type,
    idNumber: c.statutory_id_number ?? base.idNumber,
    firstName: c.first_name ?? base.firstName,
    middleName: c.middle_name ?? base.middleName,
    lastName: c.last_name ?? base.lastName,
    idIssuer: c.statutory_id_issuer ?? base.idIssuer,
    birthDate: (c.date_of_birth ?? '').slice(0, 10) || base.birthDate,
    expiryDate: (c.id_expiry_date ?? '').slice(0, 10) || base.expiryDate,
    phone: base.phone,
    sex: base.sex,
    address: base.address,
  };
}

export function statutoryPayload(d: StatutoryDraft): SaleStatutoryPayload {
  const phone = normalizePhone(d.phone); // canonical (`@shared/phone`)
  const a = d.address;
  const address = addressStarted(a) && missingAddressFields(a).length === 0 ? a : null;
  return {
    type: d.type,
    id_number: normalizeIdNumber(d.idNumber),
    first_name: d.firstName.trim(),
    middle_name: d.middleName.trim() || null,
    last_name: d.lastName.trim(),
    id_issuer: d.idIssuer.trim() || null,
    id_expiry_date: d.type === 'PWD' ? d.expiryDate || null : null,
    birth_date: d.birthDate || null,
    // Extras only when filled.
    ...(phone ? { phone_number: phone } : {}),
    ...(d.sex ? { sex: d.sex } : {}),
    ...(address
      ? {
          address: {
            line1: address.line1.trim(),
            line2: address.line2.trim() || null,
            barangay: address.barangay.trim() || null,
            city: address.city.trim(),
            province: address.province.trim(),
            region: address.region.trim() || null,
            postal_code: address.postalCode.trim(),
          },
        }
      : {}),
  };
}

export function clientName(c: { first_name: string | null; middle_name?: string | null; last_name: string | null }): string {
  const name = [c.first_name, c.middle_name, c.last_name].filter((p) => p && p.trim() !== '').join(' ');
  return name || 'Unnamed client';
}

export function statutoryHolderName(d: StatutoryDraft): string {
  return [d.firstName, d.middleName, d.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
}
