@AGENTS.md

# GamotERP POS — notes for Claude

The Android point-of-sale app for GamotERP's **Branch Sales**. React Native + Expo (SDK 57) + TypeScript, React
Navigation (native-stack — **not** Expo Router), one enrolled tablet = one POS terminal. It sells **online and
offline** and syncs to the GamotERP backend.

- **Backend + web app:** `C:\Users\ejnav\Desktop\GamotERP` (read its `CLAUDE.md`). The full design, security model and
  package split: `GamotERP/docs/plans/pos-android-app.md`. **API contract:** `GamotERP/backend/src/pos-api/contract.ts`
  (imported here as `@pos-api/contract`) — the only source of request/response shapes; never redefine them.
- **Module boundaries inside this app:** `src/contracts.ts` (DeviceKey, Jose, PosApi, LocalStore, SyncEngine,
  CashierSessionStore, ReceiptPrinter). Change a boundary there first, then its implementation and callers.

## Shared code — one copy, used by the server and this app

Imported straight from the backend through the aliases in `metro.config.js` / `tsconfig.json`:

| Alias | File | What |
|---|---|---|
| `@shared/material-issuance-pricing` | `backend/src/lib/material-issuance-pricing.ts` | every sale total: item + prorated transaction discount, 12% VAT, Senior/PWD 20% + VAT exemption, rounding |
| `@shared/discount` | `backend/src/lib/discount.ts` | ₱ / % discount → amount |
| `@shared/business-day` | `backend/src/lib/business-day.ts` | Asia/Manila business date (void same day, refund after) |
| `@shared/invoice-number` | `backend/src/lib/invoice-number.ts` | `<prefix>-000123` / `<prefix>-RT-000123` |
| `@pos-api/contract` | `backend/src/pos-api/contract.ts` | API types, `canonicalJson` (what op signatures cover) |

**Never re-implement pricing, VAT, discounts, Senior/PWD, business-day or invoice formatting here.** The server
recomputes every synced sale with the same code and flags any difference (TOTALS_MISMATCH). Those backend files must
stay import-free (no Prisma/Node) — if a change there needs an import, it breaks this app.

## Layout

| Path | Owns |
|---|---|
| `modules/pos-device/` | Local Expo module (Kotlin): Android Keystore EC P-256 key (StrongBox → TEE → software), key attestation chain, ES256 signing (raw r‖s), Play Integrity, device info |
| `src/device/` | `deviceKey` (wraps the module), `jose` (DPoP proofs, op JWS, RFC 7638 thumbprint), base64url |
| `src/api/client.ts` | `api` — every contract route; adds `Authorization: DPoP <device token>` + `DPoP` proof, and `X-Cashier-Token` on cashier routes; `ApiError` / `AppUpdateRequiredError`; `appVersion()` (use this one) |
| `src/config/serverConfig.ts` | server base URL (secure store) |
| `src/config/runtime.ts` | `isExpoGo` (the ONLY switch for Expo Go preview mode), `appVersionName()` — use it, not `Application.nativeApplicationVersion` |
| `src/db/` | `localStore` — SQLCipher DB (op-sqlite; key in secure store): enrollment, device-owned counters, bootstrap, catalog (+ search/barcode), approvers, sales, **outbox**, PIN verifiers; `policy.ts` = selling-block rules |
| `src/sync/syncEngine.ts` | `syncEngine` + `useSyncStatus` — sync loop, heartbeat, catalog refresh, offline limits, revoked / update-required |
| `src/auth/` | `cashierSession` — online sign-in (+MFA) and offline PIN unlock (PBKDF2 verifier, lockout) |
| `src/sale/`, `src/components/sale/`, `src/printer/` | cart, totals (shared pricing), checkout → `localStore.recordSale`, receipt, printer seam |
| `src/screens/` | Enroll, CashierLogin, Sell, Payment, Receipt, SalesToday (void/refund), Refund, SyncStatus, Settings |
| `src/ui/theme.ts` | MedSource brand colours (#033f74 primary, #7ab537 accent, no gradients) — import, never hardcode |

## Rules that must never be broken

1. **Invoice numbers are owned by the device** once enrolled. `localStore.recordSale` takes the next number, saves the
   sale and enqueues its signed op in ONE transaction, under a lock, **before** the receipt prints. Never reset,
   decrease or reuse a counter; the only upward adjustment is to the server's expected numbers after sync.
2. **The outbox is never dropped.** Every sale/void goes out oldest first, idempotent by `client_uuid`. A REJECTED op
   stays visible (Sync status) for a manager; nothing is deleted to "unstick" the queue.
3. **Every op is signed when created** (JWS over `canonicalJson(payload)`, device key). Don't mutate a queued payload.
4. **The private key never leaves the Keystore**; nothing secret is bundled in the app (no API keys). Tokens live in
   memory; the DB key in expo-secure-store; `android.allowBackup` is false (a restored DB without its key can't open).
5. **Voids only on the sale's own Manila business day, refunds only after — and refunds are online only.** Discount
   and void co-signs use the approver's 6-digit code; offline, the server verifies it at sync against the sale/void time.
6. **Offline limits** (terminal `offline_max_hours` / `offline_max_sales`) block selling when reached; revoked and
   update-required block it too (`src/db/policy.ts`).
7. **Money is a string** ("123.45") everywhere in payloads; totals come from the shared pricing code.

## Running it (development)

Needs **Android Studio** (Android SDK + an emulator, or a USB-debugging phone) — `npx expo run:android` builds the dev
client (the app has native code; Expo Go only runs the insecure preview below). The backend runs in Docker (`GamotERP/docker-compose.yml`)
on port 4001; from the emulator it is `http://10.0.2.2:4001/api`. The backend must run with
`POS_ATTESTATION_MODE=DEV` (the default outside production) so emulator keys (software attestation) can enroll.

```bash
npx expo run:android          # build + install the dev client, start Metro
npx expo start --dev-client   # Metro only (after the dev client is installed)
npx tsc --noEmit              # typecheck (includes the shared backend files)
```

Enroll: in the web app (signed in as a MedSource user with `pos.enroll`) → **Enroll POS** → a terminal → **Enroll
device** → scan the QR (or type the server URL + code) on the app. See `GamotERP/docs/plans/pos-android-app.md`.

### Server URLs on the office Wi-Fi (dev PC 192.168.68.54)

| URL | What | POS app |
|---|---|---|
| `http://192.168.68.54:4001/api` | the backend directly (plain HTTP) | **use this in dev** — Expo Go and dev builds allow cleartext (`usesCleartextTraffic`) |
| `https://192.168.68.54:5174/api` | HTTPS via the web app's Vite dev server (`GamotERP/frontend/vite.config.ts` proxies `/api` → backend), self-signed CA cert `CN=GamotERP dev` in `GamotERP/frontend/certs/` (git-ignored; SAN: localhost, 127.0.0.1, 192.168.68.54) | works from the phone's **browser** (the web app needs HTTPS for the camera), but **not from the app yet**: Android apps ignore user-installed CAs unless the app's network security config opts in — Expo Go never does; a dev build would need a debug-only config trusting that cert |

`GamotERP/backend/.env` sets `POS_PUBLIC_API_URL=http://192.168.68.54:4001/api` — the URL put into the Enroll POS QR code.
DPoP `htu` is matched against the URL the request arrived at **or** `POS_PUBLIC_API_URL`'s origin; behind the Vite
proxy the backend sees `localhost:4001`, so using the HTTPS URL from the app also requires `POS_PUBLIC_API_URL` to be
the HTTPS one. If the Wi-Fi IP changes: regenerate the dev cert with the new IP in subjectAltName and update both.

## Expo Go preview mode (development only)

To try the whole app on a phone **without building it**, open it in **Expo Go**. Expo Go lacks the two native pieces
a real terminal relies on, so — only when `isExpoGo` (`src/config/runtime.ts`: `Constants.executionEnvironment ===
StoreClient` **and** `isRunningInExpoGo()`) — the app falls back:

| Real build | Expo Go preview |
|---|---|
| Keystore key (`modules/pos-device`), attested | software P-256 key (`src/device/softwareDeviceKey.ts` + `softwareEs256.ts`, @noble/curves), private key hex in expo-secure-store, `attestationChain: []`, no Play Integrity, `strongBox: false` |
| SQLCipher DB `gamoterp_pos.sqlite` (op-sqlite) | **unencrypted** expo-sqlite DB `gamoterp_pos_expo_go_preview_UNENCRYPTED.sqlite` (`src/db/expoGoSqlite.ts`, an adapter for the op-sqlite subset localStore uses — `Conn` in `database.ts`); same migrations, mutex and pragmas |
| app version = installed versionName | app.json `version` (Expo Go's own version would be wrong) |

Everything else (enrollment by QR/code, cashier login, selling, outbox + sync, voids, refunds) is the same code. A
persistent "EXPO GO PREVIEW — not a secure POS" strip shows in the shell; the Enroll screen says the server must be in
DEV mode. **It enrolls only against a backend with `POS_ATTESTATION_MODE=DEV`** (never production). Rules for keeping
this safe: every fallback is chosen by `isExpoGo` alone; the fallback files and op-sqlite are loaded with a lazy
`require` so neither build evaluates the other's native-dependent code; `expo-sqlite` is excluded from Android
autolinking (`package.json` `expo.autolinking.android.exclude`) so a real build doesn't even contain it, and a real
build without SQLCipher still refuses to start rather than store sales in plaintext.

Run it: `npx expo start --go` (`--go` because expo-dev-client is installed — plain `expo start` serves the dev
client) → scan the QR with Expo Go (phone on the same Wi-Fi as the PC). The server URL for the phone is
`http://<PC LAN IP>:4001/api` — the enrollment QR says `http://10.0.2.2:4001/api` (emulator-only) unless the backend
has `POS_PUBLIC_API_URL=http://<PC LAN IP>:4001/api` in `backend/.env` (restart it), so either set that or type the
URL + code by hand. If the phone can't reach the PC, allow inbound TCP 4001 (API) and 8081 (Metro) in Windows
Firewall.

## Production checklist (not done yet)

- HTTPS only: remove `usesCleartextTraffic` (app.json / expo-build-properties) and add certificate pinning (with a
  backup pin) in the API client's network layer.
- Backend `POS_ATTESTATION_MODE=STRICT` (DEV is refused in production), `POS_APP_CERT_SHA256` = the release signing
  certificate digest (Play App Signing), `POS_TOKEN_SECRET` set, Play Integrity configured (cloud project number).
- Release build signed via Play App Signing, distributed through managed Google Play; tablets in Android Enterprise
  dedicated-device (kiosk) mode with automatic network time enforced.
- A real ESC/POS printer driver behind `src/printer/printer.ts` (currently `isAvailable() → false`, on-screen receipt).
- Check BIR POS accreditation (PTU per machine, e-journal) for offline selling with your accountant.
