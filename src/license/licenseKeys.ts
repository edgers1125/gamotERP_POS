// Public keys the POS license lease is verified with — PINNED in the app build (contract.ts "License lease").
// Never trust a key taken from the network in a release build: whoever controls the network could then mint leases.
//
// ┌─ PRODUCTION KEY — fill in before shipping the build that enforces leases ──────────────────────────────────────────
// │ The server signs with env POS_LICENSE_SIGNING_KEY (Ed25519 PKCS8 PEM) in GamotERP deploy/backend.env, kid =
// │ POS_LICENSE_KEY_ID or, by default, the RFC 7638 JWK thumbprint. Get the public half (it is NOT secret):
// │   * easiest, on the server: `docker compose -f docker-compose.prod.yml run --rm migrate npx tsx
// │     prisma/pos-license-selftest.ts` → last line "Public key to pin in the POS app: {kid, alg, jwk: {x}, spki}" —
// │     copy `kid` and `jwk.x` below;
// │   * or from the PEM: `openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '='`
// │     gives `x` (the last 32 bytes of the SPKI DER are the raw key); the kid is whatever POS_LICENSE_KEY_ID says, else
// │     base64url(sha256('{"crv":"Ed25519","kty":"OKP","x":"<x>"}')) — or just read it from a bootstrap response's
// │     `license_public_keys` (Check-in screen shows the server's kid) and compare `x` with your own derivation;
// │   * a running server also lists it in GET /pos/bootstrap `license_public_keys` — use that only to CROSS-CHECK the
// │     value you derived from the key file, never as the source.
// │ Rotation: add the NEW key here next to the old one, ship that build to every tablet, then switch the server's env
// │ key; remove the old entry in a later build.
// │ While this list is EMPTY a release build enforces nothing but the LOCKED state (licenseKeys() → [] → 'NO_KEYS',
// │ logged) — so shipping without the key never stops tablets from selling, but also gives no offline license.
// └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
import type { PosLicensePublicKey } from '@pos-api/contract';

import type { LeaseKey } from './lease';

export const PRODUCTION_LICENSE_KEYS: readonly LeaseKey[] = [
  // { kid: '<POS_LICENSE_KEY_ID or JWK thumbprint>', x: '<base64url raw 32-byte Ed25519 public key>' },
];

// Development only (__DEV__ builds): the key a development backend derives from its JWT_SECRET when
// POS_LICENSE_SIGNING_KEY is unset (backend lib/pos-license.ts). This one is the office dev Docker backend's
// (`docker exec gamoterp-backend-1 npx tsx prisma/pos-license-selftest.ts`, 2026-10-04). Another JWT_SECRET → another
// key: dev builds also trust the bootstrap's `license_public_keys` (below), so nothing needs editing to test locally.
export const DEV_LICENSE_KEYS: readonly LeaseKey[] = [
  { kid: 'Hp5uqQA5gde5tvNQ0vvjstitixytqVuOQ4GM4jtuInA', x: 'zFSYKsqsyPd8sqqDNAJ8PIK-1RlUwwXL8pgPzSaBw9c' },
];

/** Keys from a response (`license_public_keys`) — honoured ONLY in development builds. */
function networkKeys(list: readonly PosLicensePublicKey[] | null | undefined): LeaseKey[] {
  if (!Array.isArray(list)) return [];
  const out: LeaseKey[] = [];
  for (const k of list) {
    if (k && typeof k.kid === 'string' && k.kid && k.jwk && k.jwk.kty === 'OKP' && k.jwk.crv === 'Ed25519' && typeof k.jwk.x === 'string') {
      out.push({ kid: k.kid, x: k.jwk.x });
    }
  }
  return out;
}

/**
 * The keys a lease may be verified with in THIS build. Release: the pinned production keys only. Development
 * (`__DEV__`): those + the dev keys + whatever the server listed in bootstrap `license_public_keys`.
 */
export function licenseKeys(serverListed?: readonly PosLicensePublicKey[] | null): LeaseKey[] {
  const keys: LeaseKey[] = [...PRODUCTION_LICENSE_KEYS];
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    keys.push(...DEV_LICENSE_KEYS, ...networkKeys(serverListed));
  }
  return keys;
}
