# Development setup — Server URLs and Expo Go preview — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/config/serverConfig.ts` — server base URL (secure store)
- `src/config/runtime.ts` — `isExpoGo`, `appVersionName()`
- `src/device/softwareDeviceKey.ts`, `src/device/softwareEs256.ts` — Expo Go software key
- `src/db/expoGoSqlite.ts` — unencrypted expo-sqlite adapter; `src/db/database.ts` — `Conn`
- `src/screens/EnrollScreen.tsx` — Enroll screen
- `package.json` — `expo.autolinking.android.exclude`
- `app.json` — `usesCleartextTraffic`

Enroll: in the web app (signed in as a MedSource user with `pos.enroll`) → **Enroll POS** → a terminal → **Enroll
device** → scan the QR (or type the server URL + code) on the app. See `GamotERP/apps/pharma/docs/plans/pos-android-app.md`.

### Server URLs on the office Wi-Fi (dev PC 192.168.68.54)

| URL | What | POS app |
|---|---|---|
| `http://192.168.68.54:4001/api` | the backend directly (plain HTTP) | **use this in dev** — Expo Go and dev builds allow cleartext (`usesCleartextTraffic`) |
| `https://192.168.68.54:5174/api` | HTTPS via the web app's Vite dev server (`GamotERP/apps/pharma/frontend/vite.config.ts` proxies `/api` → backend), self-signed CA cert `CN=GamotERP dev` in `GamotERP/apps/pharma/frontend/certs/` (git-ignored; SAN: localhost, 127.0.0.1, 192.168.68.54) | works from the phone's **browser** (the web app needs HTTPS for the camera), but **not from the app yet**: Android apps ignore user-installed CAs unless the app's network security config opts in — Expo Go never does; a dev build would need a debug-only config trusting that cert |

`GamotERP/apps/pharma/backend/.env` sets `POS_PUBLIC_API_URL=http://192.168.68.54:4001/api` — the URL put into the Enroll POS QR code.
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
