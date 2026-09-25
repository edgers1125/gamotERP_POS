// P-A1 — the POS device key (src/contracts.ts `DeviceKey`), backed by the local Expo module modules/pos-device (Android
// Keystore EC P-256, StrongBox when available, non-exportable, attested with the enrollment challenge).
//
// Expo Go preview ONLY (src/config/runtime.ts `isExpoGo`): Expo Go can't load modules/pos-device, so the same API is
// served by a software P-256 key instead (softwareDeviceKey.ts — no attestation, no Play Integrity; enrolls only against
// a server in POS_ATTESTATION_MODE=DEV). A development or release build never loads that file.
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';

import NativePosDevice from '../../modules/pos-device';
import type { PosDeviceNativeModule } from '../../modules/pos-device';
import type { PublicJwkEC } from '@pos-api/contract';
import { isExpoGo } from '../config/runtime';
import type { DeviceKey } from '../contracts';
import { base64ToBase64Url, utf8Bytes } from './base64url';

const PosDevice: PosDeviceNativeModule | null = isExpoGo
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./softwareDeviceKey') as typeof import('./softwareDeviceKey')).softwarePosDevice
  : NativePosDevice;

const INTEGRITY_TIMEOUT_MS = 20_000;

function native(): PosDeviceNativeModule {
  if (!PosDevice) {
    throw new Error('The POS device module is not available in this build — install the GamotERP POS development/release build (not Expo Go).');
  }
  return PosDevice;
}

function toJwk(j: { x: string; y: string }): PublicJwkEC {
  return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, no whitespace. */
async function computeThumbprint(jwk: PublicJwkEC): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64ToBase64Url(digest);
}

// The public key never changes for a given key, so it (and its thumbprint) is cached until createKey/deleteKey.
let cachedJwk: PublicJwkEC | null = null;
let cachedThumbprint: { forX: string; value: string } | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export const deviceKey: DeviceKey = {
  async hasKey() {
    if (!PosDevice) return false;
    return PosDevice.hasKey();
  },

  async createKey(challengeBase64Url) {
    cachedJwk = null;
    cachedThumbprint = null;
    const created = await native().createKey(challengeBase64Url);
    cachedJwk = toJwk(created.publicJwk);
    return { publicJwk: cachedJwk, attestationChain: created.attestationChain };
  },

  async publicJwk() {
    if (cachedJwk) return cachedJwk;
    const jwk = await native().getPublicJwk();
    if (!jwk) throw new Error('This device has no POS device key — enroll it first.');
    cachedJwk = toJwk(jwk);
    return cachedJwk;
  },

  async thumbprint() {
    const jwk = await deviceKey.publicJwk();
    if (cachedThumbprint && cachedThumbprint.forX === jwk.x) return cachedThumbprint.value;
    const value = await computeThumbprint(jwk);
    cachedThumbprint = { forX: jwk.x, value };
    return value;
  },

  async sign(signingInput) {
    return native().sign(utf8Bytes(signingInput));
  },

  async deleteKey() {
    cachedJwk = null;
    cachedThumbprint = null;
    if (!PosDevice) return;
    await PosDevice.deleteKey();
  },

  async integrityToken(requestHash, cloudProjectNumber) {
    if (!PosDevice || !cloudProjectNumber) return null;
    return withTimeout(PosDevice.requestIntegrityToken(requestHash, cloudProjectNumber), INTEGRITY_TIMEOUT_MS, null);
  },

  async deviceInfo() {
    let serial: string | null = null;
    try {
      // Build.getSerial() is closed to ordinary apps since Android 10; the app-scoped ANDROID_ID is the stable
      // per-device identifier we can report (differs per signing key and user profile).
      serial = Application.getAndroidId() || null;
    } catch {
      serial = null;
    }
    if (!PosDevice) return { model: null, serial, androidSdk: null, strongBox: false };
    const info = await PosDevice.getDeviceInfo();
    // `||`: the Expo Go preview reports 0 for an unknown SDK level; the native module always reports a real one.
    return { model: info.model, serial, androidSdk: info.androidSdk || null, strongBox: info.strongBox };
  },
};
