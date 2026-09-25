// EXPO GO PREVIEW ONLY — the pure-JS ES256 used by softwareDeviceKey.ts (no Expo imports, so it can be checked under
// plain Node against node:crypto). Never used by a development or release build (those sign in the Android Keystore).
import { p256 } from '@noble/curves/nist.js';

import type { PosDeviceJwk } from '../../modules/pos-device';
import { base64UrlFromBytes } from './base64url';

/** A usable P-256 private key: 32 bytes, 1 ≤ d < n. */
export function isValidSecret(secret: Uint8Array): boolean {
  return p256.utils.isValidSecretKey(secret);
}

/** The public key as a JWK (x, y = the 32-byte coordinates, base64url). */
export function publicJwkOf(secret: Uint8Array): PosDeviceJwk {
  // Uncompressed SEC1 point: 0x04 || X (32 bytes) || Y (32 bytes).
  const pub = p256.getPublicKey(secret, false);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Unexpected P-256 public key encoding');
  return { kty: 'EC', crv: 'P-256', x: base64UrlFromBytes(pub.slice(1, 33)), y: base64UrlFromBytes(pub.slice(33, 65)) };
}

/** ES256 over `data` (the UTF-8 bytes of the JWS signing input): SHA-256 exactly once — noble's `prehash: true`
 * hashes the message itself, so `data` must NOT be pre-hashed — deterministic k (RFC 6979), JOSE raw r||s. */
export function signEs256(secret: Uint8Array, data: Uint8Array): string {
  const sig = p256.sign(data, secret, { prehash: true, lowS: true, format: 'compact', extraEntropy: false });
  if (sig.length !== 64) throw new Error('Unexpected ES256 signature length');
  return base64UrlFromBytes(sig);
}
