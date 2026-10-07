// Self-test of the license lease checks (src/license/lease.ts + licenseKeys.ts) — no device, no server, no network.
// Signs leases with a throwaway Ed25519 key (the same @noble/curves the app verifies with) and checks every rule.
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api alias from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/license-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import { ed25519 } from '@noble/curves/ed25519.js';

import { EMPTY_LICENSE_RECORD, evaluateLicense, leaseNow, verifyLease, type LeaseKey, type LicenseRecord } from '../src/license/lease';
import { licenseKeys, PRODUCTION_LICENSE_KEYS } from '../src/license/licenseKeys';

// The app's tsconfig has no Node types (React Native); this script runs under Node, so declare the bit it uses.
declare const Buffer: {
  from(data: Uint8Array | string, encoding?: 'base64url'): Uint8Array & { toString(encoding: 'base64url'): string };
};

const DAY = 86_400_000;
const enc = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const json = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const secret = ed25519.utils.randomSecretKey();
const otherSecret = ed25519.utils.randomSecretKey();
const kid = 'selftest-kid';
const keys: LeaseKey[] = [{ kid, x: enc(ed25519.getPublicKey(secret)) }];
const ids = { companyId: 1, terminalId: 2, deviceId: 3 };
const issuedAt = Date.parse('2026-10-04T00:00:00.000Z');

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    kid,
    company_id: 1,
    terminal_id: 2,
    device_id: 3,
    state: 'OK',
    issued_at: new Date(issuedAt).toISOString(),
    valid_until: new Date(issuedAt + 45 * DAY).toISOString(),
    ...over,
  };
}
function sign(p: unknown, opts: { key?: Uint8Array; headerKid?: string; alg?: string; typ?: string } = {}): string {
  const h = json({ alg: opts.alg ?? 'EdDSA', typ: opts.typ ?? 'pos-license+jwt', kid: opts.headerKid ?? kid });
  const body = json(p);
  return `${h}.${body}.${enc(ed25519.sign(new TextEncoder().encode(`${h}.${body}`), opts.key ?? secret))}`;
}

let failed = 0;
let passed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
const reason = (r: ReturnType<typeof verifyLease>) => (r.ok ? 'OK' : r.reason);

// ---- verifyLease ---------------------------------------------------------------------------------------------------
const good = sign(payload());
check('valid lease verifies', reason(verifyLease(good, keys, ids)), 'OK');
check('unknown kid', reason(verifyLease(sign(payload({ kid: 'k2' }), { headerKid: 'k2' }), keys, ids)), 'UNKNOWN_KID');
{
  const [h, , s] = good.split('.');
  const tampered = `${h}.${json(payload({ valid_until: '2099-01-01T00:00:00.000Z' }))}.${s}`;
  check('tampered payload', reason(verifyLease(tampered, keys, ids)), 'BAD_SIGNATURE');
  const sig = Buffer.from(s!, 'base64url');
  sig[10] ^= 1;
  check('tampered signature', reason(verifyLease(`${good.split('.').slice(0, 2).join('.')}.${enc(sig)}`, keys, ids)), 'BAD_SIGNATURE');
}
check('signed by a foreign key', reason(verifyLease(sign(payload(), { key: otherSecret }), keys, ids)), 'BAD_SIGNATURE');
check('lease for another device', reason(verifyLease(good, keys, { ...ids, deviceId: 9 })), 'WRONG_DEVICE');
check('lease for another terminal', reason(verifyLease(good, keys, { ...ids, terminalId: 9 })), 'WRONG_DEVICE');
check('lease for another company', reason(verifyLease(good, keys, { ...ids, companyId: 9 })), 'WRONG_DEVICE');
check('payload kid != header kid', reason(verifyLease(sign(payload({ kid: 'zz' })), keys, ids)), 'BAD_PAYLOAD');
check('payload state LOCKED refused', reason(verifyLease(sign(payload({ state: 'LOCKED' })), keys, ids)), 'BAD_PAYLOAD');
check('payload v != 1', reason(verifyLease(sign(payload({ v: 2 })), keys, ids)), 'BAD_PAYLOAD');
check(
  'valid_until <= issued_at',
  reason(verifyLease(sign(payload({ valid_until: new Date(issuedAt).toISOString() })), keys, ids)),
  'BAD_PAYLOAD',
);
check('alg none refused', reason(verifyLease(sign(payload(), { alg: 'none' }), keys, ids)), 'WRONG_ALG');
check('wrong typ refused', reason(verifyLease(sign(payload(), { typ: 'JWT' }), keys, ids)), 'WRONG_ALG');
check('two parts only', reason(verifyLease(good.split('.').slice(0, 2).join('.'), keys, ids)), 'MALFORMED');
check('padded base64 refused', reason(verifyLease(`${good.split('.')[0]}=.${good.split('.')[1]}.${good.split('.')[2]}`, keys, ids)), 'MALFORMED');

// ---- evaluateLicense -----------------------------------------------------------------------------------------------
const rec: LicenseRecord = { ...EMPTY_LICENSE_RECORD, seen: true, lease: good };
const evalAt = (record: LicenseRecord, nowMs: number, k: readonly LeaseKey[] = keys) => evaluateLicense({ record, keys: k, ids, nowMs });

check('valid on day 1', evalAt(rec, issuedAt + DAY).code, 'VALID');
check('no warning on day 1', evalAt(rec, issuedAt + DAY).warn, null);
check('expired after valid_until', evalAt(rec, issuedAt + 46 * DAY).code, 'EXPIRED');
check('expired exactly at valid_until', evalAt(rec, issuedAt + 45 * DAY).code, 'EXPIRED');
check('7-day warning (day 40)', evalAt(rec, issuedAt + 40 * DAY).warn, 'EXPIRING');
check('overdue lease warns', evalAt({ ...rec, lease: sign(payload({ state: 'OVERDUE' })) }, issuedAt + DAY).warn, 'OVERDUE');
check('overdue lease still sells', evalAt({ ...rec, lease: sign(payload({ state: 'OVERDUE' })) }, issuedAt + DAY).code, 'VALID');
{
  const floor = issuedAt + 46 * DAY; // last trusted time is past expiry; device clock rolled back to day 1
  check('clock rollback stays expired (floor)', evalAt(rec, leaseNow(issuedAt + DAY, floor)).code, 'EXPIRED');
  check('leaseNow takes the max', leaseNow(issuedAt + DAY, floor), floor);
}
check('lease issued in the device future', evalAt(rec, issuedAt - 2 * DAY).code, 'EXPIRED');
check('LOCKED blocks', evalAt({ ...rec, locked: true }, issuedAt + DAY).code, 'LOCKED');
check('never seen = not enforced', evalAt({ ...EMPTY_LICENSE_RECORD }, issuedAt + 400 * DAY).code, 'NOT_ENFORCED');
check('seen but no lease stored = expired', evalAt({ ...EMPTY_LICENSE_RECORD, seen: true }, issuedAt).code, 'EXPIRED');
check('stored lease that no longer verifies = expired', evalAt({ ...rec, lease: sign(payload(), { key: otherSecret }) }, issuedAt + DAY).code, 'EXPIRED');
check('not enrolled = expired', evaluateLicense({ record: rec, keys, ids: null, nowMs: issuedAt + DAY }).code, 'EXPIRED');

// ---- release build without a pinned production key (decision: enforce only LOCKED) --------------------------------
// In Node __DEV__ is undefined → licenseKeys() behaves like a release build.
const releaseKeys = licenseKeys([{ kid, x: keys[0]!.x } as never]);
check('release build ignores server-listed keys', releaseKeys.some((k) => k.kid === kid), false);
check('release keys = PRODUCTION_LICENSE_KEYS', releaseKeys.length, PRODUCTION_LICENSE_KEYS.length);
if (PRODUCTION_LICENSE_KEYS.length === 0) {
  check('no production key: expired lease does not block', evalAt(rec, issuedAt + 400 * DAY, releaseKeys).code, 'NO_KEYS');
  check('no production key: LOCKED still blocks', evalAt({ ...rec, locked: true }, issuedAt + DAY, releaseKeys).code, 'LOCKED');
} else {
  console.log('note  PRODUCTION_LICENSE_KEYS is pinned — the no-key cases are skipped');
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
