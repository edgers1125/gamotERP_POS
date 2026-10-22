@AGENTS.md

# GamotERP POS — notes for Claude

The Android point-of-sale app for GamotERP's **Branch Sales**. React Native + Expo (SDK 57) + TypeScript, React
Navigation (native-stack — **not** Expo Router), one enrolled tablet = one POS terminal. It sells **online and
offline** and syncs to the GamotERP backend.

- **Backend + web app:** `C:\Users\ejnav\Desktop\GamotERP` (read its `CLAUDE.md`). The full design, security model and
  package split: `GamotERP/apps/pharma/docs/plans/pos-android-app.md`. **API contract:** `GamotERP/apps/pharma/backend/src/pos-api/contract.ts`
  (imported here as `@pos-api/contract`) — the only source of request/response shapes; never redefine them.
- **Module boundaries inside this app:** `src/contracts.ts` (DeviceKey, Jose, PosApi, LocalStore, SyncEngine,
  CashierSessionStore, ReceiptPrinter). Change a boundary there first, then its implementation and callers.

## How these notes are organised

- Core rules in this file apply to every change.
- Feature notes live in `docs/claude/<area>.md` and must be read before changing that area (see the index below).
- Each area file starts with a **File map**. **When you add, move or rename a file in an area, update that area's File map in the same change; a new feature area gets its own file and a row in the index.**

## Area index

| File | Covers (sections) | Read when |
|---|---|---|
| `docs/claude/customer-display.md` | Customer display (second monitor) | touching the customer-facing second monitor (modules/pos-display, src/display) |
| `docs/claude/realtime.md` | Real-time channel | touching the /pos/realtime WebSocket, notices, heartbeat / polling fallback (src/sync/realtime.ts, syncEngine) |
| `docs/claude/license.md` | License lease | touching the license lease, pinned keys, LOCKED / expired-lease selling blocks (src/license, src/db/policy.ts) |
| `docs/claude/cash-drawer.md` | Cash drawer | touching the cash drawer, expected cash, the selling gate (src/drawer, CashDrawerScreen, localStore drawer ops) |
| `docs/claude/till-lock.md` | Cashier vs Sold By + till auto-lock | touching Cashier / Sold By, the receipt staff line, idle / background lock, tillTouch (src/auth/tillLock*, SoldByDialog, cart.ts) |
| `docs/claude/promos.md` | Store promos | touching store promos, promo price / Senior-PWD choice, promo payload fields (src/sale/promos.ts, cart.ts, PaymentScreen) |
| `docs/claude/attendance-kiosk.md` | Attendance kiosk mode | touching the attendance kiosk, attendance-only tablets, liveness, the punch queue (src/attendance, modules/pos-face, AttendanceKioskScreen) |
| `docs/claude/dev-setup.md` | Enrolling a device; Server URLs on the office Wi-Fi; Expo Go preview mode | setting up a dev device, changing server URLs, or touching any Expo Go fallback (isExpoGo, softwareDeviceKey, expoGoSqlite) |
| `docs/claude/production.md` | Production checklist | preparing a release: HTTPS / pinning, attestation, printer driver, BIR accreditation |

## Shared code — one copy, used by the server and this app

Imported straight from the backend through the aliases in `metro.config.js` / `tsconfig.json`:

| Alias | File | What |
|---|---|---|
| `@shared/material-issuance-pricing` | `backend/src/lib/material-issuance-pricing.ts` | every sale total: item + prorated transaction discount, 12% VAT, Senior/PWD 20% + VAT exemption, rounding |
| `@shared/vat-inclusive` | `backend/src/lib/vat-inclusive.ts` | VAT-inclusive mode: `shownUnitPrice` (round(price × 1.12) on vatable lines), `allocateReceiptVat` (VAT once per receipt); vectors `vat-inclusive.vectors.json` (listed in tsconfig `include`) |
| `@shared/discount` | `backend/src/lib/discount.ts` | ₱ / % discount → amount |
| `@shared/business-day` | `backend/src/lib/business-day.ts` | Asia/Manila business date (void same day, refund after) |
| `@shared/invoice-number` | `backend/src/lib/invoice-number.ts` | `<prefix>-000123` / `<prefix>-RT-000123` |
| `@shared/receipt-layout` | `backend/src/lib/receipt-layout.ts` | the official receipt's content (`assembleReceipt`, `reconciliationErrors`, `formatReceiptMoney`) — the web's own builder; `ReceiptView` mirrors the web's `SalesReceipt.tsx` |
| `@shared/phone` | `backend/src/lib/phone.ts` | THE phone rule: `normalizePhone` (canonical form every number is stored, sent and searched in), `samePhone`, `isPhMobile` |
| `@shared/promos/promo-math` | `backend/src/lib/promos/promo-math.ts` | THE store-promo price rule: `promoFor` (in force `starts_at ≤ t < ends_at`; two → lower price), `promoUnitPriceCents` (integer centavos, half-up), `compareScPwd`, `describePromoTerms` — see "Store promos" (a sub-folder of `lib/` works through the same `@shared/*` alias; listed in tsconfig `include`) |
| `@pos-api/contract` | `backend/src/pos-api/contract.ts` | API types, `canonicalJson` (what op signatures cover) |

**Never re-implement pricing, VAT, discounts, Senior/PWD, business-day, invoice formatting or phone normalisation here.** The server
recomputes every synced sale with the same code and flags any difference (TOTALS_MISMATCH). Those backend files must
stay import-free (no Prisma/Node) — if a change there needs an import, it breaks this app.

## Layout

| Path | Owns |
|---|---|
| `modules/pos-device/` | Local Expo module (Kotlin): Android Keystore EC P-256 key (StrongBox → TEE → software), key attestation chain, ES256 signing (raw r‖s), Play Integrity, device info, `getAutoTime` / `openDateSettings` (Settings.Global.AUTO_TIME / AUTO_TIME_ZONE; Date & time settings intent), `getClockAnchor` (SystemClock.elapsedRealtime + BOOT_COUNT boot id) |
| `modules/pos-display/` | Local Expo module (Kotlin): the customer-facing second monitor (`Presentation`, native views) + its image/config file cache — see "Customer display" |
| `modules/pos-face/` | Local Expo module (Kotlin): attendance kiosk camera — CameraX front preview + ML Kit face detection (`onFaces`), `captureFrame` → JPEG files under `filesDir/attendance_frames/` — see "Attendance kiosk mode" |
| `src/display/` | `displayService` (GET /pos/display + images, offline cache), `customerDisplay` (cart → display), `useCustomerDisplay` (mounted once in App.tsx) |
| `src/device/` | `deviceKey` (wraps the module), `jose` (DPoP proofs, op JWS, RFC 7638 thumbprint), base64url, `serverClock` (server − device offset learned from every response's `server_time` / `Date`; `nowMs` = wall + offset is used for the DPoP `iat` — the server accepts ±5 min, `DPOP_ACCEPTED_SKEW_SECONDS`; a refused proof is retried once; ALSO keeps a monotonic anchor (server time + elapsedRealtime + boot id, persisted) behind `corrected()`), `autoTime` (Android "Automatic date & time" via the pos-device module: `read` (with `known`), `isOn`, `openSettings`), `clockStamp` (`stampClock()` → anchored corrected time and the `PosClockReport` for a sale/void/drawer time; omits `clock` when the native build can't report auto time; attendance times stay on the device clock) |
| `src/api/client.ts` | `api` — every contract route; adds `Authorization: DPoP <device token>` + `DPoP` proof, and `X-Cashier-Token` on cashier routes; `ApiError` / `AppUpdateRequiredError`; `appVersion()` (use this one) |
| `src/config/serverConfig.ts` | server base URL (secure store) |
| `src/config/runtime.ts` | `isExpoGo` (the ONLY switch for Expo Go preview mode), `appVersionName()` — use it, not `Application.nativeApplicationVersion` |
| `src/db/` | `localStore` — SQLCipher DB (op-sqlite; key in secure store): enrollment, device-owned counters, bootstrap, catalog (+ search/barcode), approvers, sales, **outbox**, PIN verifiers; `policy.ts` = selling-block rules |
| `src/drawer/` | cash drawer: `cashDrawer.ts` (types, the ONE expected-cash calculation `drawerTally`, the selling rule `drawerSellProblem`), `useCashDrawer.ts` (open session as UI state, `useDrawerGate`) — see "Cash drawer" |
| `src/sync/syncEngine.ts` | `syncEngine` + `useSyncStatus` — sync loop, heartbeat, catalog refresh, offline limits, revoked / paused-inactive (403 `COMPANY_INACTIVE` / `TERMINAL_INACTIVE` / `MODULE_NOT_INCLUDED`, cleared by the next good call) / update-required; errors back off 5 s → 5 min (incl. 503 `SYNC_BUSY`); a 413 halves the batch (down to one op) until the outbox drains |
| `src/license/` | license lease (Ed25519, pinned keys) — `lease.ts` (pure verify/evaluate), `licenseKeys.ts` (pinned keys), `licenseEval.ts` ("now" + floor), `license.ts` (stores check-in results); see "License lease" below. Self-test: `scripts/license-selftest.ts` |
| `src/sync/realtime.ts` | real-time WebSocket (`/pos/realtime`, notices only) — owned by `syncEngine`; see "Real-time channel" below |
| `src/auth/` | `cashierSession` — online sign-in (+MFA) and offline PIN unlock (PBKDF2 verifier, lockout); `tillLock` + `tillLockPolicy` — idle / background auto-lock and the sticky Sold By reset (see "Cashier vs Sold By + till auto-lock"). Self-test: `scripts/till-lock-selftest.ts` |
| `src/sale/`, `src/components/sale/`, `src/printer/` | cart, totals (shared pricing), `promos.ts` (store promos — see "Store promos"), checkout → `localStore.recordSale`, receipt, printer seam. **VAT-inclusive prices** (same rule as web Branch Sales, GamotERP `docs/claude/pos-android.md`): the mode is ONLY the cached bootstrap's `receipt.vat_registered` (`totals.ts pricesIncludeVatOf` → cart `pricesIncludeVat`), passed to the shared pricing and sent as payload `prices_include_vat`; `unit_price` stays BEFORE VAT, screens show `cart.ts shownPrice`, the receipt prints shown prices + `pricesIncludeVat` (reprint: the payload's flag). Self-tests: `scripts/promo-selftest.ts`, `scripts/vat-vectors-selftest.ts` (backend's `vat-inclusive.vectors.json`) |
| `src/screens/` | Enroll, CashierLogin, Sell, Payment, Receipt, SalesToday (void/refund), Refund, CashDrawer, SyncStatus (titled "Check-in"), Settings, AttendanceKiosk (locked till / Attendance section of a kiosk terminal; the home of an attendance-only tablet) |
| `src/attendance/` | attendance kiosk mode: `liveness.ts` (pure challenge evaluator), `punch.ts` (payload, checks, queue serialisation), `attendanceKiosk.ts` (kiosk on/off + employee cache, signed punch queue, upload); UI in `src/components/attendance/` — see "Attendance kiosk mode". Self-test: `scripts/attendance-selftest.ts` |
| `src/ui/theme.ts` | Mirrors the web app's MUI theme: primary #445C44, secondary #527354, ivory #fffdf8 background, white surfaces, Poppins (`type.*` text styles — never add `fontWeight`, Android ignores it with custom fonts), radius 10, no gradients. Import, never hardcode (only `ReceiptView` stays black-on-white) |
| `src/ui/components/` | Button / TextField / Banner / Card / Screen — MUI-like primitives every screen uses; style changes go here, not per screen |

## Rules that must never be broken

1. **Invoice numbers are owned by the device** once enrolled. `localStore.recordSale` takes the next number, saves the
   sale and enqueues its signed op in ONE transaction, under a lock, **before** the receipt prints. Never reset,
   decrease or reuse a counter; the only upward adjustment is to the server's expected numbers after sync.
2. **The outbox is never dropped.** Every sale/void goes out oldest first, idempotent by `client_uuid`. A REJECTED op
   stays visible (Check-in screen) for a manager; nothing is deleted to "unstick" the queue.
3. **Every op is signed when created** (JWS over `canonicalJson(payload)`, device key). Don't mutate a queued payload.
4. **The private key never leaves the Keystore**; nothing secret is bundled in the app (no API keys). Tokens live in
   memory; the DB key in expo-secure-store; `android.allowBackup` is false (a restored DB without its key can't open).
5. **Voids only on the sale's own Manila business day, refunds only after — and refunds are online only.** Discount
   and void co-signs use the approver's 6-digit code; offline, the server verifies it at sync against the sale/void time.
6. **Offline limits** (terminal `offline_max_hours` / `offline_max_sales`) block selling when reached, unless the
   terminal has `offline_unlimited` (then only the not-checked-in warning after `offline_warn_hours`). Revoked,
   paused by the administrator (403 company/terminal inactive), update-required, subscription LOCKED and an expired license lease block it too (`src/db/policy.ts`, in that order).
   Only selling is ever blocked — check-in, voids, X/Z readings, reprints, export and settings never are.
7. **Money is a string** ("123.45") everywhere in payloads; totals come from the shared pricing code.
8. **Never lock the screen orientation** (app.json `"orientation": "default"`). Locked to landscape, Android's camera
   compatibility treatment rotated the WHOLE app to portrait whenever the scanner opened (seen on the Pixel Tablet
   emulator, even with the opt-outs in `plugins/withNoCameraCompatRotation.js`). Tablets are landscape-first anyway;
   lock rotation device-wide (kiosk policy / auto-rotate off), and keep layouts flex-based so portrait still works.

9. **Device clock** (2026-10-12; server side: ERP plan "Device clock trust"). Selling is refused while Android
   "Automatic date & time" is off (`policy.ts` `AUTO_TIME_OFF_MESSAGE` via `blockReason` `autoTimeOn`; `localStore.recordSale`
   re-reads it every time; voids are NOT refused — user decision 2026-10-22, rule 6 — their clock report says
   `auto_time: false` and the server times their stock effect at upload; the Sell screen banner has a "Date & time settings" button; the status is
   re-read when the app returns to the foreground). A setting that can't be read counts as OFF. Every sale/void is
   stamped when MADE: `sold_at` / `voided_at` = the corrected time and `clock: { auto_time, server_offset_ms,
   offset_measured_at }` (`stampClock()`), inside the signed payload — so a late sync carries the values from creation.
   Corrected time = MONOTONIC ANCHOR (server time + `elapsedRealtime` + boot id stored at each server contact; now =
   anchor + elapsed delta, only while the boot id matches) — NOT wall clock + offset (defeatable offline). No anchor (after
   a reboot until the next contact) → raw device time, `server_offset_ms: null`, `offset_measured_at: null`. A native build
   without `getAutoTime` → selling allowed but the `clock` report is OMITTED. Drawer open/close/movement times use the same
   corrected time, so the business day agrees with the sale's. Never stamp from sync time.

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

**Customer display on the emulator:** Settings → System → Developer options → **Simulate secondary displays** → pick a
size (e.g. 1920×1080). A second window appears and the app's `Presentation` shows on it; switching it off/on tests
hot-plug. Only the Kotlin can be compiled without a device: `cd android && ./gradlew :pos-display:compileDebugKotlin`.
