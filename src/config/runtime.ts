// Where this JS bundle is running. The ONLY switch for "Expo Go preview mode" (CLAUDE.md): in Expo Go the two native
// pieces a real terminal relies on — the modules/pos-device Keystore key and op-sqlite/SQLCipher — don't exist, so the
// app falls back to a software P-256 key (src/device/softwareDeviceKey.ts) and an UNENCRYPTED expo-sqlite database
// (src/db/database.ts). Development and release builds never take those paths.
import { isRunningInExpoGo } from 'expo';
import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';

/** True only inside the Expo Go app. Both checks must agree: expo-constants reports `storeClient` only in Expo Go
 * (a native build of this app always reports `bare` on Android), and `isRunningInExpoGo()` sees Expo Go's own native
 * module. Requiring both means a real build can never be mistaken for Expo Go and silently lose its hardware key. */
export const isExpoGo: boolean =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient && isRunningInExpoGo();

/** This app's version (app.json "version"). In a native build that is the installed versionName; in Expo Go the
 * native version is Expo Go's own, so the manifest's version is used instead. */
export function appVersionName(): string {
  if (isExpoGo) return Constants.expoConfig?.version ?? '0.0.0';
  return Application.nativeApplicationVersion ?? '0.0.0';
}

/** The native build number, or null (none in Expo Go — it would be Expo Go's). */
export function appBuildNumber(): string | null {
  if (isExpoGo) return null;
  return Application.nativeBuildVersion ?? null;
}
