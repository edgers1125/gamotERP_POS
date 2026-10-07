// The POS app license lease — verification and evaluation, PURE (no React Native / Expo imports, so it can be checked
// under plain Node: scripts/license-selftest.ts). Format and rules: backend contract.ts "License lease" and
// GamotERP/apps/pharma/docs/plans/pos-license-and-billing-lock.md Part B "as built" / Part C.
//
// A lease is a compact JWS `B64(header).B64(payload).B64(sig)` (base64url, no padding), header
// { alg: 'EdDSA', typ: 'pos-license+jwt', kid }, payload PosLicensePayload, signature = Ed25519 (RFC 8032, strict — not
// ZIP-215) over the ASCII bytes of `<header b64>.<payload b64>` EXACTLY as received (never re-serialized).
//
// Crypto: @noble/curves (already a dependency for the Expo Go preview's P-256 key) — audited, pure JS, synchronous,
// works in Hermes without WebCrypto. Its ed25519 uses @noble/hashes' sha512 (a dependency of @noble/curves).
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  POS_LICENSE_CLOCK_SKEW_SECONDS,
  POS_LICENSE_JWS_TYP,
  POS_LICENSE_WARN_DAYS,
  type PosLicensePayload,
} from '@pos-api/contract';

/** A verification key: kid → the raw 32-byte Ed25519 public key as base64url (= the JWK's `x`). */
export interface LeaseKey {
  kid: string;
  x: string;
}

export interface LeaseIds {
  companyId: number;
  terminalId: number;
  deviceId: number;
}

export type LeaseVerifyResult =
  | { ok: true; payload: PosLicensePayload; issuedAtMs: number; validUntilMs: number }
  | { ok: false; reason: 'MALFORMED' | 'WRONG_ALG' | 'UNKNOWN_KID' | 'BAD_SIGNATURE' | 'BAD_PAYLOAD' | 'WRONG_DEVICE'; detail: string };

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL[i]!] = i;

/** base64url (no padding) → bytes; null when it isn't canonical base64url. */
export function bytesFromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = B64URL_INDEX[text[i]!];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // Leftover bits must be zero (canonical encoding — otherwise two strings would decode to the same bytes).
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** UTF-8 bytes → string (the header/payload JSON). Throws on invalid UTF-8. */
function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let cp: number;
    let n: number;
    if (b < 0x80) {
      cp = b;
      n = 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = b & 0x1f;
      n = 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 0x0f;
      n = 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = b & 0x07;
      n = 4;
    } else {
      throw new Error('invalid UTF-8');
    }
    if (i + n > bytes.length) throw new Error('invalid UTF-8');
    for (let k = 1; k < n; k++) {
      const c = bytes[i + k]!;
      if ((c & 0xc0) !== 0x80) throw new Error('invalid UTF-8');
      cp = (cp << 6) | (c & 0x3f);
    }
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

function asciiBytes(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) return null;
    out[i] = c;
  }
  return out;
}

function decodeJson(part: string): unknown {
  const bytes = bytesFromBase64Url(part);
  if (!bytes) throw new Error('not base64url');
  return JSON.parse(utf8Decode(bytes));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
function isoMs(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * Contract steps 1–2 (not the clock): exactly 3 parts; header alg EdDSA + typ; the key with that kid among `keys`
 * (only PINNED keys — the caller decides which); Ed25519 over the first two parts as sent; payload v = 1, kid = header
 * kid, ids = this device's, state OK | OVERDUE, issued_at < valid_until.
 */
export function verifyLease(lease: string, keys: readonly LeaseKey[], ids: LeaseIds): LeaseVerifyResult {
  if (typeof lease !== 'string') return { ok: false, reason: 'MALFORMED', detail: 'not a string' };
  const parts = lease.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false, reason: 'MALFORMED', detail: 'not a compact JWS' };
  const [h, p, s] = parts as [string, string, string];

  let header: unknown;
  try {
    header = decodeJson(h);
  } catch (e) {
    return { ok: false, reason: 'MALFORMED', detail: `header: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(header) || header.alg !== 'EdDSA' || header.typ !== POS_LICENSE_JWS_TYP) {
    return { ok: false, reason: 'WRONG_ALG', detail: 'header alg/typ is not EdDSA / pos-license+jwt' };
  }
  const kid = header.kid;
  if (typeof kid !== 'string' || !kid) return { ok: false, reason: 'MALFORMED', detail: 'header has no kid' };
  const key = keys.find((k) => k.kid === kid);
  if (!key) return { ok: false, reason: 'UNKNOWN_KID', detail: `no pinned key with kid ${kid}` };

  const pub = bytesFromBase64Url(key.x);
  const sig = bytesFromBase64Url(s);
  const signingInput = asciiBytes(`${h}.${p}`);
  if (!pub || pub.length !== 32) return { ok: false, reason: 'UNKNOWN_KID', detail: `pinned key ${kid} is not a 32-byte Ed25519 key` };
  if (!sig || sig.length !== 64 || !signingInput) return { ok: false, reason: 'BAD_SIGNATURE', detail: 'malformed signature' };
  let valid = false;
  try {
    valid = ed25519.verify(sig, signingInput, pub, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'BAD_SIGNATURE', detail: 'signature does not verify' };

  let payload: unknown;
  try {
    payload = decodeJson(p);
  } catch (e) {
    return { ok: false, reason: 'BAD_PAYLOAD', detail: `payload: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(payload) || payload.v !== 1 || payload.kid !== kid) {
    return { ok: false, reason: 'BAD_PAYLOAD', detail: 'payload v / kid mismatch' };
  }
  if (payload.state !== 'OK' && payload.state !== 'OVERDUE') return { ok: false, reason: 'BAD_PAYLOAD', detail: 'payload state is not OK/OVERDUE' };
  if (!isId(payload.company_id) || !isId(payload.terminal_id) || !isId(payload.device_id)) {
    return { ok: false, reason: 'BAD_PAYLOAD', detail: 'payload ids missing' };
  }
  const issuedAtMs = isoMs(payload.issued_at);
  const validUntilMs = isoMs(payload.valid_until);
  if (issuedAtMs === null || validUntilMs === null || validUntilMs <= issuedAtMs) {
    return { ok: false, reason: 'BAD_PAYLOAD', detail: 'payload issued_at / valid_until invalid' };
  }
  if (payload.company_id !== ids.companyId || payload.terminal_id !== ids.terminalId || payload.device_id !== ids.deviceId) {
    return { ok: false, reason: 'WRONG_DEVICE', detail: 'lease is for another device / terminal / company' };
  }
  return { ok: true, payload: payload as unknown as PosLicensePayload, issuedAtMs, validUntilMs };
}

// ---- the clock -----------------------------------------------------------------------------------------------------

/**
 * "Now" for judging a lease: the server-clock estimate (device time + learned offset), never below the stored floor
 * (the last trusted server time). Contract step 3.
 */
export function leaseNow(estimateMs: number, floorMs: number): number {
  return Math.max(estimateMs, floorMs);
}

// ---- evaluation ----------------------------------------------------------------------------------------------------

/** What the device stores (meta `license`, src/db/localStore.ts). */
export interface LicenseRecord {
  v: 1;
  /** A check-in has ever carried `license` (the server issues leases). Until then nothing is enforced (rollout grace). */
  seen: boolean;
  /** The server said the subscription is LOCKED (license.state, 403 SUBSCRIPTION_LOCKED, realtime 4402). */
  locked: boolean;
  /** The newest lease that verified when it arrived (largest issued_at); null = none / discarded on LOCKED. */
  lease: string | null;
  // The floor for "now" (last trusted server time, ms) is stored separately (meta `license_floor_ms`, localStore) so
  // that raising it never races a rewrite of this record.
  /** Display fields of the last `license` received (never trusted for unlocking). */
  last: { state: 'OK' | 'OVERDUE' | 'LOCKED'; overdue_since: string | null; lock_on: string | null; at: string } | null;
}

export const EMPTY_LICENSE_RECORD: LicenseRecord = { v: 1, seen: false, locked: false, lease: null, last: null };

export type LicenseCode =
  | 'NOT_ENFORCED' // no license ever received (old server / no signing key) — rollout grace, never blocks
  | 'NO_KEYS' // leases are issued but this build pins no key at all — logged, never blocks (see licenseKeys.ts)
  | 'VALID'
  | 'EXPIRED' // the stored lease ran out (or there is none / it doesn't verify)
  | 'LOCKED';

export interface LicenseEvaluation {
  code: LicenseCode;
  /** Payload state of the valid lease. */
  state: 'OK' | 'OVERDUE' | null;
  validUntilMs: number | null;
  /** Show the warning: OVERDUE, or within POS_LICENSE_WARN_DAYS of valid_until. */
  warn: 'OVERDUE' | 'EXPIRING' | null;
  /** Why the lease isn't valid (diagnostics). */
  detail: string | null;
}

/** Contract step 3 + the app rules: LOCKED → block; never seen → don't block; else a verified, unexpired lease. */
export function evaluateLicense(input: {
  record: LicenseRecord;
  keys: readonly LeaseKey[];
  ids: LeaseIds | null;
  nowMs: number; // already leaseNow(estimate, floor)
  verify?: (lease: string) => LeaseVerifyResult; // memoized verifyLease (same keys/ids)
}): LicenseEvaluation {
  const { record, keys, ids, nowMs } = input;
  const none = { state: null, validUntilMs: null, warn: null } as const;
  if (record.locked) return { code: 'LOCKED', ...none, detail: 'subscription locked' };
  if (!record.seen) return { code: 'NOT_ENFORCED', ...none, detail: 'the server has not issued a license' };
  if (keys.length === 0) return { code: 'NO_KEYS', ...none, detail: 'this app build pins no license key' };
  if (!record.lease) return { code: 'EXPIRED', ...none, detail: 'no lease stored' };
  if (!ids) return { code: 'EXPIRED', ...none, detail: 'device not enrolled' };
  const v = input.verify ? input.verify(record.lease) : verifyLease(record.lease, keys, ids);
  if (!v.ok) return { code: 'EXPIRED', ...none, detail: `${v.reason}: ${v.detail}` };
  if (nowMs < v.issuedAtMs - POS_LICENSE_CLOCK_SKEW_SECONDS * 1000) {
    return { code: 'EXPIRED', ...none, detail: 'lease issued in the future of this device clock' };
  }
  if (nowMs >= v.validUntilMs) {
    return { code: 'EXPIRED', state: v.payload.state, validUntilMs: v.validUntilMs, warn: null, detail: 'lease expired' };
  }
  const warn =
    v.payload.state === 'OVERDUE'
      ? 'OVERDUE'
      : v.validUntilMs - nowMs <= POS_LICENSE_WARN_DAYS * 86_400_000
        ? 'EXPIRING'
        : null;
  return { code: 'VALID', state: v.payload.state, validUntilMs: v.validUntilMs, warn, detail: null };
}
