// Local Expo module: the POS device key (Android Keystore / StrongBox, key attestation), ES256 signing, device facts and
// Play Integrity. Android only. See docs/plans/pos-android-app.md ("Security model") in the GamotERP repo.
export { default } from './src/PosDeviceModule';
export * from './src/PosDevice.types';
