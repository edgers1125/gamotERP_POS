# Production checklist — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `app.json` — `usesCleartextTraffic` (via expo-build-properties); `eas.json` — release builds
- `src/api/client.ts` — network layer (certificate pinning goes here)
- `src/printer/printer.ts` — printer seam (`isAvailable() → false`)
- `src/license/licenseKeys.ts` — `PRODUCTION_LICENSE_KEYS`

## Production checklist (not done yet)

- HTTPS only: remove `usesCleartextTraffic` (app.json / expo-build-properties) and add certificate pinning (with a
  backup pin) in the API client's network layer.
- Backend `POS_ATTESTATION_MODE=STRICT` (DEV is refused in production), `POS_APP_CERT_SHA256` = the release signing
  certificate digest (Play App Signing), `POS_TOKEN_SECRET` set, Play Integrity configured (cloud project number).
- Release build signed via Play App Signing, distributed through managed Google Play; tablets in Android Enterprise
  dedicated-device (kiosk) mode with automatic network time enforced.
- A real ESC/POS printer driver behind `src/printer/printer.ts` (currently `isAvailable() → false`, on-screen receipt).
- Check BIR POS accreditation (PTU per machine, e-journal) for offline selling with your accountant.
