# Production checklist — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `app.json` — `usesCleartextTraffic` (via expo-build-properties); `eas.json` — release builds
- `src/api/client.ts` — network layer (certificate pinning goes here)
- `src/printer/printer.ts` — printer seam (`isAvailable() → false`)
- `src/license/licenseKeys.ts` — `PRODUCTION_LICENSE_KEYS`
- `plugins/withReleaseSigning.js` — release signing (config plugin; android/ is prebuild output, never edit it by hand)

## Release signing (`plugins/withReleaseSigning.js`, 2026-10-23)

- The release key is the user's (`D:/keys/gamoterp-pos-release.keystore`, alias `gamoterp-pos`, PKCS12) — never copied into
  the repo, never typed or read by Claude. The plugin reads `GAMOTERP_POS_RELEASE_STORE_FILE` / `_KEY_ALIAS` /
  `_STORE_PASSWORD` / `_KEY_PASSWORD` from Gradle properties (`%USERPROFILE%/.gradle/gradle.properties`, outside the repo)
  or env vars. None set → release build signed with the DEBUG key (logged; test builds only); some set / file missing
  → the build fails. Re-applied by every `expo prebuild` (idempotent marker). Check: `./gradlew :app:signingReport`
  (Variant release → Store/Alias/SHA-256) and `apksigner verify --print-certs` on the APK.
- Server: `POS_APP_CERT_SHA256` (GamotERP `deploy/backend.env.example`) = that key's certificate SHA-256 — checked ONLY at
  enrollment (STRICT key attestation, and Play Integrity when configured); enrolled tablets aren't re-checked. One
  value only. Debug key SHA-256 (template `debug.keystore`): `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`.
- Debug-signed → release-signed on a tablet = **uninstall first** (Android refuses a different signer): the app data
  (SQLCipher DB, device key, unsent sales / punches) is deleted, so check in until "Unsent" sales AND "Unsent punches"
  are 0, then uninstall, install, re-enroll (Enroll POS → the terminal → Enroll device).

## Production checklist (not done yet)

- HTTPS only: remove `usesCleartextTraffic` (app.json / expo-build-properties) and add certificate pinning (with a
  backup pin) in the API client's network layer.
- Backend `POS_ATTESTATION_MODE=STRICT` (DEV is refused in production), `POS_APP_CERT_SHA256` = the release signing
  certificate digest (Play App Signing), `POS_TOKEN_SECRET` set, Play Integrity configured (cloud project number).
- Release build signed via Play App Signing, distributed through managed Google Play; tablets in Android Enterprise
  dedicated-device (kiosk) mode with automatic network time enforced.
- A real ESC/POS printer driver behind `src/printer/printer.ts` (currently `isAvailable() → false`, on-screen receipt).
- Check BIR POS accreditation (PTU per machine, e-journal) for offline selling with your accountant.
