// Statutory discounts on the till — Senior Citizen / PWD (RA 9994 / RA 10754), NAAC (RA 10699), Solo Parent (RA 11861)
// and Medal of Valor (RA 9049); GamotERP docs/plans/bir-statutory-discounts-contract.md. The card lives on the client.
// THE rules (eligibility, expiry, Solo Parent child age, line → card) are the backend's `@shared/statutory-rules` and the
// rate / VAT arithmetic the shared pricing code's; this file holds the card drafts the cashier fills in, the company's
// rules from the cached bootstrap (`statutoryConfigOf`) and the checks the server would otherwise flag at sync.
import { businessToday } from '@shared/business-day';
import { normalizePhone } from '@shared/phone';
import {
  DEFAULT_STATUTORY_RULES,
  STATUTORY_TYPES,
  STATUTORY_TYPE_LABEL,
  soloParentChildIssue,
  statutoryIdHasExpiry,
  statutoryIdNeedsExpiry,
  type StatutoryRules,
  type StatutoryType,
  type StatutoryTypeRule,
} from '@shared/statutory-rules';
import type { PosBootstrap, PosClient, SaleStatutoryPayload } from '@pos-api/contract';

export type { StatutoryType, StatutoryTypeRule, StatutoryRules } from '@shared/statutory-rules';
export { STATUTORY_TYPES } from '@shared/statutory-rules';

/**
 * The company's statutory discount rules as this sale uses them. `known` false = an older server (bootstrap without
 * `statutory_discounts`): only Senior / PWD at 20 %, VAT-exempt, and the payload exactly as before (no rate / vat_exempt).
 */
export interface StatutoryConfig {
  known: boolean;
  rules: StatutoryRules;
  /** Settings → Statutory discounts "One statutory discount per sale" (true = one card per sale). */
  oneTypePerSale: boolean;
}

export const LEGACY_STATUTORY_CONFIG: StatutoryConfig = {
  known: false,
  rules: {
    ...DEFAULT_STATUTORY_RULES,
    NAAC: { ...DEFAULT_STATUTORY_RULES.NAAC, enabled: false },
    SOLO_PARENT: { ...DEFAULT_STATUTORY_RULES.SOLO_PARENT, enabled: false },
    MEDAL_OF_VALOR: { ...DEFAULT_STATUTORY_RULES.MEDAL_OF_VALOR, enabled: false },
  },
  oneTypePerSale: true,
};

/** The rules from the cached bootstrap (`statutory_discounts`); absent → LEGACY_STATUTORY_CONFIG. A type the server
 * doesn't list, or with an unreadable rate, keeps its default (SENIOR / PWD are fixed by law anyway). */
export function statutoryConfigOf(bootstrap: Pick<PosBootstrap, 'statutory_discounts'> | null | undefined): StatutoryConfig {
  const sd = bootstrap?.statutory_discounts;
  if (!sd || !Array.isArray(sd.types)) return LEGACY_STATUTORY_CONFIG;
  const rules: StatutoryRules = { ...DEFAULT_STATUTORY_RULES };
  for (const t of sd.types) {
    if (!STATUTORY_TYPES.includes(t.type)) continue;
    const rate = Number(t.rate);
    rules[t.type] = {
      enabled: t.enabled === true,
      ratePercent: Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : DEFAULT_STATUTORY_RULES[t.type].ratePercent,
      vatExempt: t.vat_exempt === true,
    };
  }
  return { known: true, rules, oneTypePerSale: sd.one_type_per_sale !== false };
}

export function sameStatutoryConfig(a: StatutoryConfig, b: StatutoryConfig): boolean {
  return (
    a.known === b.known &&
    a.oneTypePerSale === b.oneTypePerSale &&
    STATUTORY_TYPES.every((t) => {
      const x = a.rules[t];
      const y = b.rules[t];
      return x.enabled === y.enabled && x.ratePercent === y.ratePercent && x.vatExempt === y.vatExempt;
    })
  );
}

/** The types the cashier may pick now (enabled ones, in law order). */
export function offeredStatutoryTypes(config: StatutoryConfig): StatutoryType[] {
  return STATUTORY_TYPES.filter((t) => config.rules[t].enabled);
}

/** "20%" / "10%" / "12.5%" — a rate as printed on screens. */
export function ratePercentText(ratePercent: number): string {
  return `${Math.round(ratePercent * 100) / 100}%`;
}

/** "20% · VAT-exempt" / "20% · VAT applies" — what the type gives (type picker). */
export function statutoryRuleText(rule: StatutoryTypeRule): string {
  return `${ratePercentText(rule.ratePercent)} · ${rule.vatExempt ? 'VAT-exempt' : 'VAT applies'}`;
}

export interface SoloParentChildDraft {
  name: string;
  birthDate: string; // YYYY-MM-DD or ''
}

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
  expiryDate: string; // YYYY-MM-DD or '' — required for PWD / Solo Parent, optional NAAC / Medal of Valor, never Senior
  // Solo Parent only: booklet no. (optional), the children the discount is for (≥ 1, each 6 or younger on the sale day)
  // and the cashier's attestation that a prescription item's prescription is in the child's name.
  bookletNumber: string;
  children: SoloParentChildDraft[];
  rxInChildName: boolean;
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
  bookletNumber: '',
  children: [],
  rxInChildName: false,
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

/** "Senior Citizen" / "PWD" / "National Athlete / Coach (NAAC)" / "Solo Parent" / "Medal of Valor". */
export function statutoryTypeLabel(type: StatutoryType): string {
  return STATUTORY_TYPE_LABEL[type];
}

/** Short name for chips and rows: "Senior" / "PWD" / "NAAC" / "Solo Parent" / "Medal of Valor". */
export function statutoryShortLabel(type: StatutoryType): string {
  return type === 'SENIOR' ? 'Senior' : type === 'NAAC' ? 'NAAC' : STATUTORY_TYPE_LABEL[type];
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

/** The Solo Parent children actually filled in (a blank row is ignored). */
export function filledChildren(d: Pick<StatutoryDraft, 'children'>): SoloParentChildDraft[] {
  return d.children.filter((c) => c.name.trim() !== '' || c.birthDate !== '');
}

/** Why the card can't be used yet (null = ready). `saleDay` = the Manila day the Solo Parent child age is judged on. */
export function statutoryProblem(d: StatutoryDraft, saleDay: string = businessToday()): string | null {
  const label = statutoryTypeLabel(d.type);
  if (d.idNumber.trim() === '') return `Enter the ${label} ID number.`;
  if (d.idNumber.trim().length > 64) return 'The ID number must be 64 characters or fewer.';
  if (d.firstName.trim() === '' || d.lastName.trim() === '') return 'Enter the cardholder’s first and last name.';
  if (d.birthDate !== '' && !isValidDate(d.birthDate)) return 'Use the date format YYYY-MM-DD for the birth date.';
  if (d.birthDate !== '' && d.birthDate > businessToday()) return 'The birth date can’t be in the future.';
  if (statutoryIdHasExpiry(d.type)) {
    if (d.expiryDate === '' && statutoryIdNeedsExpiry(d.type)) return `Enter the ${label} ID’s expiry date.`;
    if (d.expiryDate !== '' && !isValidDate(d.expiryDate)) return 'Use the date format YYYY-MM-DD for the expiry date.';
    if (isIdExpired(d.expiryDate)) return `This ${label} ID expired on ${formatDateOnly(d.expiryDate)} — update the card details.`;
  }
  if (d.type === 'SOLO_PARENT') {
    if (d.bookletNumber.trim().length > 64) return 'The booklet number must be 64 characters or fewer.';
    const children = filledChildren(d);
    if (children.length === 0) return 'Add the child the Solo Parent discount is for (name and birth date).';
    if (children.length > 10) return 'Add at most 10 children.';
    for (const c of children) {
      if (c.name.trim().length > 150) return 'A child’s name must be 150 characters or fewer.';
      const issue = soloParentChildIssue({ name: c.name, birth_date: c.birthDate }, saleDay);
      if (issue) return `${issue}.`;
    }
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
 * Whether a client's card on record can be applied as-is when they're picked (`config` = the company's rules now): the
 * type must be offered; a Senior Citizen ID never expires; a PWD / Solo Parent ID needs an expiry date that hasn't passed
 * (Manila today counts as valid), a NAAC / Medal of Valor one may have none; a Solo Parent card also needs the child,
 * which isn't on record — so it always opens the card. Returns why not, or null when usable.
 */
export function clientStatutoryBlock(c: PosClient, config: StatutoryConfig = LEGACY_STATUTORY_CONFIG): string | null {
  if (!clientHasStatutory(c)) return null;
  const label = statutoryTypeLabel(c.statutory_type);
  if (!config.rules[c.statutory_type].enabled) return `Their ${label} card can’t be used here — that discount isn’t offered for your company.`;
  if (c.statutory_type === 'SOLO_PARENT') return 'Open Statutory discount to add the child the Solo Parent discount is for.';
  if (!statutoryIdHasExpiry(c.statutory_type)) return null;
  const expiry = (c.id_expiry_date ?? '').slice(0, 10);
  if (expiry === '') return statutoryIdNeedsExpiry(c.statutory_type) ? `Their ${label} ID has no expiry date on record — open Statutory discount to enter it.` : null;
  if (isIdExpired(expiry)) return `Their ${label} ID expired on ${formatDateOnly(expiry)} — the discount wasn’t applied. Open Statutory discount if they have a renewed card.`;
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
    bookletNumber: c.statutory_booklet_number ?? base.bookletNumber,
    children: base.children,
    rxInChildName: base.rxInChildName,
    phone: base.phone,
    sex: base.sex,
    address: base.address,
  };
}

/**
 * The card as the payload carries it. `rule` = what the device charged for this type's lines (sent as rate /
 * vat_exempt) — null for an older server (LEGACY config: the payload exactly as before).
 */
export function statutoryPayload(d: StatutoryDraft, rule: StatutoryTypeRule | null = null): SaleStatutoryPayload {
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
    id_expiry_date: statutoryIdHasExpiry(d.type) ? d.expiryDate || null : null,
    birth_date: d.birthDate || null,
    ...(rule ? { rate: rule.ratePercent.toFixed(2), vat_exempt: rule.vatExempt } : {}),
    ...(d.type === 'SOLO_PARENT'
      ? {
          booklet_number: d.bookletNumber.trim() || null,
          children: filledChildren(d).map((c) => ({ name: c.name.trim(), birth_date: c.birthDate })),
          rx_in_child_name: d.rxInChildName,
        }
      : {}),
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
