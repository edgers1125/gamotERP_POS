// P-A1 — JOSE for the POS device (src/contracts.ts `Jose`): DPoP proofs (RFC 9449, contract "AUTH") and the compact JWS
// that signs each offline op's payload (contract SyncOp.signature). ES256 with the Keystore device key.
import * as Crypto from 'expo-crypto';

import { canonicalJson } from '@pos-api/contract';
import type { SalePayload, VoidPayload } from '@pos-api/contract';
import type { Jose } from '../contracts';
import { base64ToBase64Url, base64UrlFromString } from './base64url';
import { deviceKey } from './deviceKey';

async function compactJws(header: Record<string, unknown>, payloadText: string): Promise<string> {
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(payloadText)}`;
  const signature = await deviceKey.sign(signingInput);
  return `${signingInput}.${signature}`;
}

/** `htu`: the request URL without query string or fragment (RFC 9449 §4.2). */
export function htuOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** base64url(SHA-256(ASCII access token)) — the proof's `ath` claim. */
export async function accessTokenHash(accessToken: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, accessToken, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64ToBase64Url(digest);
}

export const jose: Jose = {
  async dpopProof(method, url, accessToken) {
    const jwk = await deviceKey.publicJwk();
    const claims: Record<string, unknown> = {
      htm: method.toUpperCase(),
      htu: htuOf(url),
      iat: Math.floor(Date.now() / 1000),
      jti: Crypto.randomUUID(),
    };
    if (accessToken) claims.ath = await accessTokenHash(accessToken);
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    return compactJws(header, JSON.stringify(claims));
  },

  async signOpPayload(payload: SalePayload | VoidPayload) {
    const kid = await deviceKey.thumbprint();
    return compactJws({ alg: 'ES256', typ: 'pos-op+jws', kid }, canonicalJson(payload));
  },
};
