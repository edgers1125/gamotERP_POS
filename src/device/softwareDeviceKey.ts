// EXPO GO PREVIEW ONLY (src/config/runtime.ts `isExpoGo`) — deviceKey.ts `require`s this file only on that path, so a
// development or release build never loads it and always uses the Android Keystore module (modules/pos-device).
//
// Expo Go has no modules/pos-device, so the preview uses a SOFTWARE EC P-256 key (@noble/curves, pure JS) with the same
// JS API as the native module (PosDeviceNativeModule): the private key is 32 random bytes (expo-crypto) kept as hex in
// expo-secure-store, there is no attestation chain (only a server in POS_ATTESTATION_MODE=DEV accepts that) and no
// Play Integrity. The key is extractable by anyone who can read the app's secure storage — a preview, not a terminal.
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';

import type { PosDeviceCreatedKey, PosDeviceNativeModule } from '../../modules/pos-device';
import { isValidSecret, publicJwkOf, signEs256 } from './softwareEs256';

const STORE_KEY = 'gamoterp_pos_expo_go_preview_device_key_v1';

let cachedSecret: Uint8Array | null | undefined; // undefined = not read yet

async function readSecret(): Promise<Uint8Array | null> {
  if (cachedSecret !== undefined) return cachedSecret;
  const hex = await SecureStore.getItemAsync(STORE_KEY);
  cachedSecret = hex ? hexToBytes(hex) : null;
  return cachedSecret;
}

export const softwarePosDevice: PosDeviceNativeModule = {
  async hasKey() {
    return (await readSecret()) !== null;
  },

  async createKey(_challengeBase64Url): Promise<PosDeviceCreatedKey> {
    // Nothing can attest a software key, so the challenge isn't bound into anything here.
    let secret = Crypto.getRandomBytes(32);
    while (!isValidSecret(secret)) secret = Crypto.getRandomBytes(32); // 0 or ≥ n: ~2^-32 odds
    const hex = bytesToHex(secret);
    await SecureStore.setItemAsync(STORE_KEY, hex);
    if ((await SecureStore.getItemAsync(STORE_KEY)) !== hex) throw new Error('Could not store the preview device key.');
    cachedSecret = secret;
    return { publicJwk: publicJwkOf(secret), attestationChain: [], securityLevel: 'SOFTWARE', attested: false };
  },

  async getPublicJwk() {
    const secret = await readSecret();
    return secret ? publicJwkOf(secret) : null;
  },

  async sign(data) {
    const secret = await readSecret();
    if (!secret) throw new Error('This device has no POS device key — enroll it first.');
    return signEs256(secret, data);
  },

  async deleteKey() {
    cachedSecret = null;
    await SecureStore.deleteItemAsync(STORE_KEY);
  },

  async getDeviceInfo() {
    return {
      model: Device.modelName ?? null,
      // 0 = unknown; deviceKey.ts turns it into null (the server wants a positive SDK level or null).
      androidSdk: Device.platformApiLevel ?? 0,
      strongBox: false,
    };
  },

  async requestIntegrityToken() {
    return null;
  },
};
