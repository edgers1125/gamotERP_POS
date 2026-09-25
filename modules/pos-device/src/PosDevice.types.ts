// JS API of the local `PosDevice` Expo module (android/src/main/java/com/medsource/gamoterp/posdevice/PosDeviceModule.kt).

export interface PosDeviceJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string; // base64url, 32 bytes
  y: string; // base64url, 32 bytes
}

export type PosDeviceSecurityLevel = 'STRONGBOX' | 'TEE' | 'SOFTWARE';

export interface PosDeviceCreatedKey {
  publicJwk: PosDeviceJwk;
  /** Key attestation chain, leaf first, each standard base64 DER. [] when the Keystore could not attest the key. */
  attestationChain: string[];
  /** Where the key actually lives (informational — the server decides from the attestation itself). */
  securityLevel: PosDeviceSecurityLevel;
  attested: boolean;
}

export interface PosDeviceInfo {
  model: string | null;
  androidSdk: number;
  /** PackageManager.FEATURE_STRONGBOX_KEYSTORE */
  strongBox: boolean;
}

export interface PosDeviceNativeModule {
  /** Whether the device key (fixed alias) exists. */
  hasKey(): Promise<boolean>;
  /** Creates the device key, replacing any old one: EC P-256, non-exportable, SIGN, SHA-256, attestation challenge =
   * the decoded challenge; StrongBox → TEE → unattested fallback. Rejects when no key could be created at all. */
  createKey(challengeBase64Url: string): Promise<PosDeviceCreatedKey>;
  /** The public key as a JWK, or null when there is no key. */
  getPublicJwk(): Promise<PosDeviceJwk | null>;
  /** ES256 (SHA256withECDSA) over `data`; returns the JOSE signature (raw r||s, 64 bytes) base64url. Rejects
   * when there is no key (enroll first). */
  sign(data: Uint8Array): Promise<string>;
  deleteKey(): Promise<void>;
  getDeviceInfo(): Promise<PosDeviceInfo>;
  /** Play Integrity standard request token for `requestHash` — null (never throws) when unavailable. */
  requestIntegrityToken(requestHash: string, cloudProjectNumber: string): Promise<string | null>;
}
