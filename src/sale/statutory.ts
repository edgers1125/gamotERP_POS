// Statutory discounts — Senior Citizen / PWD (RA 9994 / RA 10754, docs/plans/pos-terminals-payments-scpwd.md REVISION 2:
// the card lives on the client) and, BIR Phase 2 (GamotERP docs/plans/bir-statutory-discounts-contract.md), NAAC, Solo
// Parent and Medal of Valor. THE rules (eligibility, expiry, the Solo Parent child age, labels) are the backend's
// `@shared/statutory-rules`; the rate / VAT arithmetic is the shared pricing code's; each type's rate + VAT treatment +
// on/off come from the company's settings (bootstrap `statutory_discounts`, edited on the web — Settings → Statutory
// discounts). This file only holds the card draft the cashier fills in, the bootstrap rules and the checks the server
// would otherwise flag at sync.
import { businessToday } from '@shared/business-day';
import { normalizePhone } from '@shared/phone';
import {
  DEFAULT_STATUTORY_RULES,
  STATUTORY_SHORT_LABEL,
  STATUTORY_TYPES,
  STATUTORY_TYPE_LABEL,
  soloParentChildIssue,
  statutoryIdHasExpiry,
  statutoryIdNeedsExpiry,
  type StatutoryRules,
  type StatutoryType,
} from '@shared/statutory-rules';
import type { PosBootstrap, PosClient, SaleStatutoryPayload } from '@pos-api/contract';

export type { StatutoryType } from '@shared/statutory-rules';

// ---- the company's rules (bootstrap statutory_discounts) ---------------------------------------------------------------

export interface StatutoryConfig {
  rules: StatutoryRules;
  /** Settings → Statutory discounts "One statutory discount per sale" (Phase 2b: false = one card per type). */
  oneTypePerSale: boolean;
  /** The server sent `statutory_discounts` — only then may NAAC / Solo Parent / Medal of Valor and the new card fields
   * (rate, vat_exempt, Solo Parent extras) be sent (an older server rejects an unknown type). */
  known: boolean;
}

/** An older server (no `statutory_discounts`): Senior / PWD only, 20 %, VAT-exempt, one card per sale. */
export const LEGACY_STATUTORY_CONFIG: StatutoryConfig = {
  rules: {
    ...DEFAULT_STATUTORY_RULES,
    NAAC: { ...DEFAULT_STATUTORY_RULES.NAAC, enabled: false },
    SOLO_PARENT: { ...DEFAULT_STATUTORY_RULES.SOLO_PARENT, enabled: false },
    MEDAL_OF_VALOR: { ...DEFAULT_STATUTORY_RULES.MEDAL_OF_VALOR, enabled: false },
  },
  oneTypePerSale: true,
  known: false,
};

const RATE = /^\d{1,3}(\.\d{1,2})?$/;

/** The cached bootstrap's rules, read defensively (absent → LEGACY; a malformed entry keeps that type's default; SENIOR /
 * PWD are fixed by law whatever is sent). */
export function statutoryConfigOf(bootstrap: Pick<PosBootstrap, 'statutory_discounts'> | null | undefined): StatutoryConfig {
  const sd = bootstrap?.statutory_discounts as unknown;
  if (!sd || typeof sd !== 'object' || !Array.isArray((sd as { types?: unknown }).types)) return LEGACY_STATUTORY_CONFIG;
  const rules: StatutoryRules = { ...DEFAULT_STATUTORY_RULES };
  for (const raw of (sd as { types: unknown[] }).types) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const type = e.type as StatutoryType;
    if (!STATUTORY_TYPES.includes(type) || type === 'SENIOR' || type === 'PWD') continue;
    const rate = typeof e.rate === 'number' ? String(e.rate) : e.rate;
    if (typeof rate !== 'string' || !RATE.test(rate) || Number(rate) > 100) continue;
    if (typeof e.enabled !== 'boolean' || typeof e.vat_exempt !== 'boolean') continue;
    rules[type] = { enabled: e.enabled, ratePercent: Number(rate), vatExempt: e.vat_exempt };
  }
  return { rules, oneTypePerSale: (sd as { one_type_per_sale?: unknown }).one_type_per_sale !== false, known: true };
}

export function sameStatutoryConfig(a: StatutoryConfig, b: StatutoryConfig): boolean {
  return a.known === b.known && a.oneTypePerSale === b.oneTypePerSale && STATUTORY_TYPES.every((t) => {
    const x = a.rules[t];
    const y = b.rules[t];
    return x.enabled === y.enabled && x.ratePercent === y.ratePercent && x.vatExempt === y.vatExempt;
  });
}

/** The card types the cashier may offer now (in the law's order). */
export function offeredTypes(config: StatutoryConfig): StatutoryType[] {
  return STATUTORY_TYPES.filter((t) => config.rules[t].enabled);
}

/** "20%" / "10.5%". */
export function ratePercentText(ratePercent: number): string {
  return `${Math.round(ratePercent * 100) / 100}%`;
}

/** What the type gives, for the cashier: "20% off eligible items, VAT-exempt" / "20% off, VAT charged on the rest". */
export function ruleSummary(config: StatutoryConfig, type: StatutoryType): string {
  const r = config.rules[type];
  return `${ratePercentText(r.ratePercent)} off eligible items, ${r.vatExempt ? 'VAT-exempt' : 'VAT charged on the discounted price'}`;
}

/** The discount row label: "SC 20%", "Solo Parent 10%". */
export function discountRowLabel(config: StatutoryConfig, type: StatutoryType): string {
  return `${STATUTORY_SHORT_LABEL[type]} ${ratePercentText(config.rules[type].ratePercent)}`;
}

// ---- the card the cashier fills in -----------------------------------------------------------------------------------

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
  expiryDate: string; // YYYY-MM-DD or '' — required for PWD / Solo Parent, optional NAAC / Medal of Valor, none for Senior
  // Solo Parent only (sent only on a SOLO_PARENT card): booklet no. (optional), the children (≥ 1, ≤ 10, each ≤ 6 years
  // old on the sale day) and the cashier's attestation that a prescription item's prescription is in the child's name.
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

export const MAX_SOLO_PARENT_CHILDREN = 10;

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
  return type === 'NAAC' ? 'NAAC' : STATUTORY_TYPE_LABEL[type];
}

/** The long name ("National Athlete / Coach (NAAC)") — for pickers where there's room. */
export function statutoryTypeLongLabel(type: StatutoryType): string {
  return STATUTORY_TYPE_LABEL[type];
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

/** What the card checks need besides the draft: the rules, the sale's Manila day, whether a Solo Parent line is Rx. */
export interface StatutoryCheckContext {
  config: StatutoryConfig;
  /** YYYY-MM-DD (Asia/Manila) — default today. */
  saleDay?: string;
  /** A line getting this card is a prescription item (Solo Parent: the cashier must attest the Rx is in the child's name). */
  rxLine?: boolean;
}

/** Why the card can't be used yet (null = ready). Mirrors the server's checks (contract §4) so nothing is flagged at sync. */
export function statutoryProblem(d: StatutoryDraft, ctx: StatutoryCheckContext): string | null {
  const label = statutoryTypeLabel(d.type);
  if (!ctx.config.rules[d.type].enabled) {
    return d.type === 'MEDAL_OF_VALOR'
      ? 'The Medal of Valor discount is turned off for your company (Settings → Statutory discounts on the web).'
      : `The ${label} discount isn’t available on this terminal yet.`;
  }
  if (d.idNumber.trim() === '') return `Enter the ${label} ID number.`;
  if (d.idNumber.trim().length > 64) return 'The ID number must be 64 characters or fewer.';
  if (d.firstName.trim() === '' || d.lastName.trim() === '') return 'Enter the cardholder’s first and last name.';
  if (d.birthDate !== '' && !isValidDate(d.birthDate)) return 'Use the date format YYYY-MM-DD for the birth date.';
  if (d.birthDate !== '' && d.birthDate > businessToday()) return 'The birth date can’t be in the future.';
  if (statutoryIdNeedsExpiry(d.type) && d.expiryDate === '') return `Enter the ${label} ID’s expiry date.`;
  if (statutoryIdHasExpiry(d.type) && d.expiryDate !== '') {
    if (!isValidDate(d.expiryDate)) return 'Use the date format YYYY-MM-DD for the expiry date.';
    if (isIdExpired(d.expiryDate)) return `This ${label} ID expired on ${formatDateOnly(d.expiryDate)} — update the card details.`;
  }
  if (d.type === 'SOLO_PARENT') {
    if (d.bookletNumber.trim().length > 64) return 'The booklet number must be 64 characters or fewer.';
    if (d.children.length === 0) return 'Add the child the Solo Parent discount is for (name and birth date).';
    if (d.children.length > MAX_SOLO_PARENT_CHILDREN) return `At most ${MAX_SOLO_PARENT_CHILDREN} children.`;
    const day = ctx.saleDay ?? businessToday();
    for (const ch of d.children) {
      if (ch.name.trim().length > 150) return 'A child’s name must be 150 characters or fewer.';
      const issue = soloParentChildIssue({ name: ch.name, birth_date: ch.birthDate }, day);
      if (issue) return `${issue}.`;
    }
    if (ctx.rxLine && !d.rxInChildName) return 'A prescription item gets the Solo Parent discount only when the prescription is in the child’s name — confirm it.';
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
 * Whether a client's card on record can be applied as-is when they're picked: the type must be offered (Medal of Valor
 * may be off; a new type needs a server that knows it); a Senior Citizen ID never expires; a PWD / Solo Parent ID needs
 * an expiry date that hasn't passed (Manila today counts as valid); a NAAC / Medal of Valor expiry, when on record, must
 * not have passed. A Solo Parent card also needs this sale's children — it is never applied by itself. Returns why
 * not, or null when usable.
 */
export function clientStatutoryBlock(c: PosClient, config: StatutoryConfig = LEGACY_STATUTORY_CONFIG, inForm = false): string | null {
  if (!clientHasStatutory(c)) return null;
  const type = c.statutory_type;
  const label = statutoryTypeLabel(type);
  if (!config.rules[type].enabled) return `Their ${label} card can’t be used on this terminal — the discount is turned off.`;
  const expiry = (c.id_expiry_date ?? '').slice(0, 10);
  if (statutoryIdNeedsExpiry(type) && expiry === '') return `Their ${label} ID has no expiry date on record — open the client to enter it.`;
  if (statutoryIdHasExpiry(type) && expiry !== '' && isIdExpired(expiry)) {
    return `Their ${label} ID expired on ${formatDateOnly(expiry)} — the discount wasn’t applied. Open the client if they have a renewed card.`;
  }
  // In the client form the children are typed right there; elsewhere a Solo Parent card can't be applied by itself.
  if (type === 'SOLO_PARENT' && !inForm) return 'Solo Parent card on record — open the client (Change) to add the child this sale is for.';
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
 * The card as sent (SaleStatutoryPayload). `config.known` (a server with statutory_discounts): + `rate` / `vat_exempt` =
 * what the device charged for this type's lines, and on a Solo Parent card its booklet / children / attestation
 * (`rxLine`: a line getting this card is an Rx item — otherwise the attestation is null). An older server gets exactly
 * the pre-Phase-2 shape.
 */
export function statutoryPayload(d: StatutoryDraft, config: StatutoryConfig = LEGACY_STATUTORY_CONFIG, rxLine = false): SaleStatutoryPayload {
  const phone = normalizePhone(d.phone); // canonical (`@shared/phone`)
  const a = d.address;
  const address = addressStarted(a) && missingAddressFields(a).length === 0 ? a : null;
  const rule = config.rules[d.type];
  return {
    type: d.type,
    id_number: normalizeIdNumber(d.idNumber),
    first_name: d.firstName.trim(),
    middle_name: d.middleName.trim() || null,
    last_name: d.lastName.trim(),
    id_issuer: d.idIssuer.trim() || null,
    id_expiry_date: statutoryIdHasExpiry(d.type) ? d.expiryDate || null : null,
    birth_date: d.birthDate || null,
    ...(config.known ? { rate: rule.ratePercent.toFixed(2), vat_exempt: rule.vatExempt } : {}),
    ...(config.known && d.type === 'SOLO_PARENT'
      ? {
          booklet_number: d.bookletNumber.trim() || null,
          children: d.children.map((ch) => ({ name: ch.name.trim(), birth_date: ch.birthDate })),
          rx_in_child_name: rxLine ? d.rxInChildName : null,
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
