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

## Shared code — one copy, used by the server and this app

Imported straight from the backend through the aliases in `metro.config.js` / `tsconfig.json`:

| Alias | File | What |
|---|---|---|
| `@shared/material-issuance-pricing` | `backend/src/lib/material-issuance-pricing.ts` | every sale total: item + prorated transaction discount, 12% VAT, Senior/PWD 20% + VAT exemption, rounding |
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
| `modules/pos-device/` | Local Expo module (Kotlin): Android Keystore EC P-256 key (StrongBox → TEE → software), key attestation chain, ES256 signing (raw r‖s), Play Integrity, device info |
| `modules/pos-display/` | Local Expo module (Kotlin): the customer-facing second monitor (`Presentation`, native views) + its image/config file cache — see "Customer display" |
| `modules/pos-face/` | Local Expo module (Kotlin): attendance kiosk camera — CameraX front preview + ML Kit face detection (`onFaces`), `captureFrame` → JPEG files under `filesDir/attendance_frames/` — see "Attendance kiosk mode" |
| `src/display/` | `displayService` (GET /pos/display + images, offline cache), `customerDisplay` (cart → display), `useCustomerDisplay` (mounted once in App.tsx) |
| `src/device/` | `deviceKey` (wraps the module), `jose` (DPoP proofs, op JWS, RFC 7638 thumbprint), base64url, `serverClock` (server − device offset learned from every response's `server_time` / `Date`; used ONLY for the DPoP `iat` — the server accepts ±5 min, `DPOP_ACCEPTED_SKEW_SECONDS`; a refused proof is retried once; sale/void/drawer times stay on the device clock) |
| `src/api/client.ts` | `api` — every contract route; adds `Authorization: DPoP <device token>` + `DPoP` proof, and `X-Cashier-Token` on cashier routes; `ApiError` / `AppUpdateRequiredError`; `appVersion()` (use this one) |
| `src/config/serverConfig.ts` | server base URL (secure store) |
| `src/config/runtime.ts` | `isExpoGo` (the ONLY switch for Expo Go preview mode), `appVersionName()` — use it, not `Application.nativeApplicationVersion` |
| `src/db/` | `localStore` — SQLCipher DB (op-sqlite; key in secure store): enrollment, device-owned counters, bootstrap, catalog (+ search/barcode), approvers, sales, **outbox**, PIN verifiers; `policy.ts` = selling-block rules |
| `src/drawer/` | cash drawer: `cashDrawer.ts` (types, the ONE expected-cash calculation `drawerTally`, the selling rule `drawerSellProblem`), `useCashDrawer.ts` (open session as UI state, `useDrawerGate`) — see "Cash drawer" |
| `src/sync/syncEngine.ts` | `syncEngine` + `useSyncStatus` — sync loop, heartbeat, catalog refresh, offline limits, revoked / update-required; errors back off 5 s → 5 min (incl. 503 `SYNC_BUSY`); a 413 halves the batch (down to one op) until the outbox drains |
| `src/license/` | license lease (Ed25519, pinned keys) — `lease.ts` (pure verify/evaluate), `licenseKeys.ts` (pinned keys), `licenseEval.ts` ("now" + floor), `license.ts` (stores check-in results); see "License lease" below. Self-test: `scripts/license-selftest.ts` |
| `src/sync/realtime.ts` | real-time WebSocket (`/pos/realtime`, notices only) — owned by `syncEngine`; see "Real-time channel" below |
| `src/auth/` | `cashierSession` — online sign-in (+MFA) and offline PIN unlock (PBKDF2 verifier, lockout); `tillLock` + `tillLockPolicy` — idle / background auto-lock and the sticky Sold By reset (see "Cashier vs Sold By + till auto-lock"). Self-test: `scripts/till-lock-selftest.ts` |
| `src/sale/`, `src/components/sale/`, `src/printer/` | cart, totals (shared pricing), `promos.ts` (store promos — see "Store promos"), checkout → `localStore.recordSale`, receipt, printer seam. Self-test: `scripts/promo-selftest.ts` |
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
   update-required, subscription LOCKED and an expired license lease block it too (`src/db/policy.ts`, in that order).
   Only selling is ever blocked — check-in, voids, X/Z readings, reprints, export and settings never are.
7. **Money is a string** ("123.45") everywhere in payloads; totals come from the shared pricing code.
8. **Never lock the screen orientation** (app.json `"orientation": "default"`). Locked to landscape, Android's camera
   compatibility treatment rotated the WHOLE app to portrait whenever the scanner opened (seen on the Pixel Tablet
   emulator, even with the opt-outs in `plugins/withNoCameraCompatRotation.js`). Tablets are landscape-first anyway;
   lock rotation device-wide (kiosk policy / auto-rotate off), and keep layouts flex-based so portrait still works.

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

### Customer display (second monitor, `modules/pos-display`, `src/display/`)

The tablet drives a monitor over HDMI / USB-C facing the customer. Native, not a second React root: an
`android.app.Presentation` on the first `DISPLAY_CATEGORY_PRESENTATION` display, laid out with plain Android views
(`CustomerPresentation.kt`); JS only sends what to show. Every string (money included) is formatted in JS — the Kotlin
does no maths.

- **Cart has lines** (Sell → Payment): LEFT half = brand on the BACKDROP (MedSource deep blue #033f74 for the standard
  brand, else the brand's own primary) — the logo with a thin white contour that traces its alpha shape (no white card;
  `outlinedLogo`: white SRC_IN silhouettes stamped around it, ~3 px), name in ivory, accent bar (MedSource green
  #7ab537, or the brand's own secondary) and a thin accent strip down its inner edge (along the bottom when the brand is
  full-screen); RIGHT half = a darker panel (backdrop 30% towards black) with each line (name, qty × unit price, amount,
  item / Senior-PWD discount), then the same rows as `TotalsSummary` and a "due" box with a large TOTAL in the accent
  (+ cash received / change). Contrast is enforced natively (ivory on backdrop ≥ 7:1, muted / accent text ≥ 4.5:1). Figures come only from `cartTotals` (shared pricing). Client = first name only.
  On Payment, cash received + change once the cash line is valid (`customerDisplay.setPayment`).
- **Sale completed** (Receipt screen, fresh sale only — not reprints/voids): "Thank you" + total/change/receipt no. for
  8 s, then back to the cart state; the next customer's first item ends it early.
- **Empty cart**: the branch's ads full-screen, each for its `duration_seconds`; no ads (or none decodable) → the brand
  full-screen. Also shown while the till is locked.
- JS API (`modules/pos-display/src/PosDisplayModule.ts`): `isAvailable()`, `setConfig(json)`, `showCart(json)`,
  `showThankYou(json)`, `showIdle()`, event `onDisplayChange {available}`, plus the file cache `saveImage`,
  `imagePath`, `pruneImages`, `readConfigCache`, `writeConfigCache`. The module keeps the last config + screen and
  re-renders them itself on hot-plug / Activity resume; it dismisses the Presentation when the app goes to the
  background or the Activity is destroyed. Without a second display (or in Expo Go, where the module is absent)
  every call is a no-op.
- **Config** (contract "Customer display", device auth, no cashier): `displayService.refresh()` runs after every
  bootstrap refresh in `syncEngine` (startup, after enrollment, every ~15 min while polling) and on a real-time
  `display` notice / `state` mismatch. Same `version` + files present → no
  download; otherwise each image is fetched only if no file with its checksum exists (files are named by checksum),
  then the config is cached (`filesDir/customer_display/config.json`), pushed, and unused files pruned. A failure keeps
  the previous cache. At startup the cache is pushed first, so it works fully offline.
- Colours: the brand's from the server; the neutral palette (ivory, text, muted, success, border) is sent from
  `src/ui/theme.ts`, plus `displayBackground` / `accent` (`displayColors` in `displayService.ts`: a standard primary
  → MedSource blue + green). Flat colours only. Fonts: the Poppins faces expo-font registered (via `ReactFontManager`), else sans-serif. Text sizes
  scale with the monitor's height.

### Real-time channel (`src/sync/realtime.ts`, `GamotERP/apps/pharma/docs/plans/pos-realtime-channel.md`)

- A WebSocket to `<server base URL>/pos/realtime` (http→ws, https→wss) carrying **notices only**; data still comes from
  the REST endpoints and every write stays REST (outbox `POST /pos/sync`, refunds). Handshake headers =
  `api/client.ts` `deviceAuthHeaders('GET', <http(s) URL>)` (device token + DPoP proof, htu = the http(s) form).
- `syncEngine` owns it: wanted while enrolled, not revoked, no update required, network up, app in the foreground
  (closed in the background). Open → `hello` (app version, pending ops, cached catalog / display / approvers
  versions); `state` → applied like a heartbeat reply, then whatever version differs is fetched; `changed` → catalog
  download / `displayService.refresh()` / the three approver lists (needs an online cashier — deferred until one exists,
  version kept in `meta.approvers_version`) / bootstrap (`terminal`). `status` frame when the outbox count changes (1/s).
- **Terminal version** = bootstrap's `bootstrap_version`, stored in `meta.bootstrap_version` by `saveBootstrap` (null
  when the server sent none; cleared on (re-)enroll) and sent as `hello.versions.terminal`. `state`: re-read bootstrap
  when it differs from the server's; if either side is null, the old "re-read once after a real outage" rule applies.
  `changed` 'terminal': re-read unless the stored version equals the notice's (a null version always re-reads). A
  bootstrap re-read bumps `lastSyncAt` (so `usePosData`/receipts re-read it) and fetches the receipt logo by checksum.
- **While connected (`useSyncStatus().live`) there is no heartbeat and no 15-min bootstrap polling.** When it is down,
  the old polling runs unchanged as the fallback. Manual "Sync now" (`syncNow({ checkVersions: true })`) always
  re-checks catalog (heartbeat) + display + approvers.
- Keep-alive: RN never surfaces ping frames to JS (and its `ws.ping()` sends a BINARY frame — never use it), so any
  server message resets a 90 s idle timer; on expiry the socket is recycled at once (cheap: catch-up fetches nothing).
  Backoff 1 s → 60 s exponential with jitter; close 1012/1011 → random 5–30 s first; 1013 (server's hello throttle) → usual backoff. Close 4001 → revoked, 4026 → update required, 4400 → logged + backoff.

### License lease (`src/license/`, `GamotERP/apps/pharma/docs/plans/` POS license plan, Part C)

- Every check-in (device token, heartbeat, bootstrap) can carry `license` = `{ state, lease, … }`. `lease` is a compact
  JWS (`alg EdDSA`, `typ pos-license+jwt`, `kid`) over `{ v:1, kid, company_id, terminal_id, device_id, state OK|OVERDUE,
  issued_at, valid_until }`. The app verifies it with **pinned** keys only (`licenseKeys.ts`, `@noble/curves` ed25519,
  strict `zip215: false` like node:crypto); the bootstrap's `license_public_keys` are trusted in `__DEV__` builds only.
- Stored in the SQLCipher meta table: `license` (record: seen / locked / newest verified lease / last display fields),
  `license_floor_ms` (last trusted server time) and `last_check_in_at`. A new lease replaces the stored one only if it
  verifies and is newer; its `issued_at` resets the floor. Re-enroll drops lease + lock but keeps `seen` and the floor.
- "Now" = max(server-clock estimate, floor, in-session monotonic time) — rolling the device clock back can't revive an
  expired lease. Selling stops when LOCKED (403 `SUBSCRIPTION_LOCKED`, realtime close 4402, or `license.state`) or
  when a lease is missing/expired once any `license` was ever seen. Never seen → not enforced (rollout grace).
  Warnings (not blocking): OVERDUE, and within 7 days of `valid_until`. While locked, realtime and catalog pause.
- **Decision:** a release build with `PRODUCTION_LICENSE_KEYS` empty enforces **only LOCKED** (code `NO_KEYS`), so a
  build shipped without the key can't stop every tablet. Pin the production key before release: run
  `prisma/pos-license-selftest.ts` on the server (last line prints kid + jwk.x), or derive x from the PEM. Rotation:
  pin old + new, ship, then switch the server key.
- Self-test (no device/server): `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json
  scripts/license-selftest.ts` — signs leases with a throwaway key and checks every rule; exit 0 = all passed.
- **Wording:** cashier-facing text says **"check in" / "Check-in"** and **"unsent"** — never "sync" / "synced" /
  "waiting to sync". (Code identifiers — `syncEngine`, `sync_status`, `SyncStatusScreen` — keep their names.)

### Cash drawer (`src/drawer/`, `src/screens/CashDrawerScreen.tsx`, `GamotERP/apps/pharma/docs/plans/sales-side-tables-and-cash-drawer.md` §B)

- **The app is the ONLY place drawer data is entered** (the web's Branch Tracker → Cash Drawer is a read-only tally).
  Top-bar section **Cash drawer**: open with an opening float → **Cash in / Cash out** (amount > 0 + required reason,
  ≤ 200) → **Close** with a **blind count** (counted cash + optional note ≤ 500, confirm dialog; expected cash and the
  Over/Short — green balanced / red short / amber over — appear only AFTER the count is saved). Below: today's closed
  sessions. The cashier on every op is the signed-in one; **locking the till does not close the drawer**.
- **Storage + sync:** `cash_drawer_sessions` / `cash_drawer_movements` (migration v3, which also rebuilt `outbox` for
  the new op types). `localStore.openDrawer` / `recordDrawerMovement` / `closeDrawer` save the row AND enqueue the
  signed `DRAWER_OPEN` / `DRAWER_MOVEMENT` / `DRAWER_CLOSE` op (contract "Cash drawer") in ONE transaction, under
  `counterLock` like `recordSale`, so they go out in order with the sales. A session's client_uuid = its DRAWER_OPEN
  op's. `applyResults` stores each op's result on its row (`sync_status` / `close_sync_status`). One OPEN session per
  device (partial unique index); sessions and movements are never deleted (not even by `clearEnrollment`).
- **Expected cash** (`drawerTally` in `cashDrawer.ts` — used by the screen AND for `device_expected_cash`, computed
  at `closed_at` under `counterLock`): opening float + Σ CASH payment amounts of this device's sales with `sold_at` in
  [opened_at, closed_at/now) that aren't voided (a REJECTED void still counts; a REJECTED sale doesn't) − cash paid
  back by refunds made here (`local_refunds`, written by RefundScreen after the server records a refund; the refunded
  sale's own CASH payments, so only for sales rung up on this device — others are shown as "not included") + cash in −
  cash out. CASH = the method's kind in bootstrap/catalog, else the sale's receipt snapshot, else "has cash received".
  The server computes its own figure (the truth) and flags a difference.
- **Selling gate:** no OPEN session for THIS terminal → Charge / Complete sale disabled with "Open the cash drawer to
  start selling." and a banner button to the Cash drawer section (`useDrawerGate` + `DrawerGateBanner`, Sell and
  Payment screens). `localStore.recordSale` refuses on the same rule (`drawerSellProblem`). A session left open for a
  different terminal (re-enrolled device) blocks selling until it is counted and closed.

### Cashier vs Sold By + till auto-lock (`src/auth/tillLock.ts`, contract "Cashier vs Sold By + idle lock")

User decision 2026-10-07 (`GamotERP/apps/pharma/docs/plans/sales-incentives.md` decision 7 + "As built — cashier vs
seller, idle lock"); it replaced a "seller taps name + attendance PIN" design that was never shipped — don't bring a seller
PIN back.
- **Cashier** = the signed-in one (`SalePayload.cashier_user_id`) — the top bar reads "Cashier: <name>", Payment shows
  Cashier + Sold by.
- **Sold By** = picked by the cashier from bootstrap `sales_staff` (`SoldByDialog`, "Who sold it?") — **never filled in
  by the app** (not the cashier, not the only person on the list); "Me (<name>)" when the cashier is on the list.
  **Sticky:** the cart keeps it across sales (`reset()` keeps it) until changed, the till locks, the cashier signs out or
  another cashier signs in (`useTillAutoLock` subscribes to `useCashier`). Someone taken off the list is un-picked. An
  empty list = no sale can be completed (Charge stays disabled) — a manager adds Sales Staff on the web.
- **Receipt:** `ReceiptData.staff_line` "Cashier: X · Sold by: Y" (shared `@shared/receipt-layout` `staffLine`), from
  names snapshotted at the sale (`ReceiptSnapshot.cashierName / soldByName`, `checkout.ts`), else today's Sales Staff
  list; the screen (`ReceiptView`) and the ESC/POS text print it under Trans No. / Date / Ref.
- **Auto-lock:** bootstrap `till.idle_lock_minutes` (branch setting on the web, Branches › Manage POS; 0 = off; absent =
  20 — `idleLockMinutesOf`). Locks via `cashierSession.lock()` (exactly the Lock button: the same cashier's PIN resumes an
  online session) after that many minutes without a touch, and when the app has been in the background ≥ 10 s
  (`BACKGROUND_GRACE_MS` — screen off / home; a short system dialog such as a permission prompt doesn't lock; checked
  again on return because JS timers may not run in the background). "A touch": the root view's
  `onStartShouldSetResponderCapture` (App.tsx `SafeFrame`), every `Sheet` and the Void dialog (a Modal is its own native
  window — `tillTouch` in `components/sale/ui.tsx`), typing in a `TextField`, a cart change a PERSON makes. **A new `Modal` must call
  `tillTouch` the same way.** The locked till shows why it locked (`useTillLockNotice`).
- **Cart changes that count** (code-review fix 2026-10-09): only `isUserCartChange` (tillLockPolicy.ts — lines, client,
  Sold By, discounts + reason, Senior/PWD, note, channel), and never one made inside `systemUpdate` in `cart.ts`
  (`isSystemCartUpdate`: promo re-checks, a newer price list, stock hints). `cart.setPromos` is a no-op when the promos
  are the same (`samePromoList`, canonical JSON) — every bootstrap re-read (each heartbeat while real-time is down) builds
  a new array, and counting that as a touch meant the till never locked. **A new cart action the app runs by itself must
  go through `systemUpdate`; a new person-facing cart field must join `ACTIVITY_KEYS`.**
- **Clock** (decision 2026-10-09, "the clock" in tillLockPolicy.ts): stamps carry the wall clock AND `performance.now()`
  (RN HighResTimeStamp = `std::chrono::steady_clock` = CLOCK_MONOTONIC on Android — no new native code; it doesn't advance
  in deep sleep, so it can only under-count). Elapsed = max(monotonic, wall): setting the clock back can't delay a lock,
  forward only locks sooner. Background check: a negative wall elapsed (clock set back while away) locks at once; with no
  monotonic source a negative wall elapsed locks at once in both checks.
- Self-test: `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/till-lock-selftest.ts`.
- **Release:** backend first (bootstrap `till`); this build also works against an older server (20 min default). Older
  builds keep their old default-to-cashier Sold By until updated — raise the terminals' `min_app_version` once the fleet
  runs this build if that must stop everywhere.

### Store promos (`src/sale/promos.ts`, contract `PosPromo`, `GamotERP/apps/pharma/docs/plans/labels-promos-recommendations.md` decisions 4–6 + "POS app work")

- **Source:** bootstrap `promos` (published, this branch, not ended — scheduled ones included so they start/stop on time
  OFFLINE), cached with the bootstrap JSON; read by `promosOf` (absent from an older server → none; malformed entries
  skipped). Publish / cancel / end early change `bootstrap_version` → real-time `changed` 'terminal' → bootstrap re-read
  (existing path) → `usePosData` reloads → SellScreen `cart.setPromos` re-checks the cart. A promo ending on time needs
  no notice (judged by time).
- **The price** is only `@shared/promos/promo-math` (never re-implemented): a line of a listed SKU is charged
  `promoUnitPrice(channel price, promo)` when that is LOWER (else the promo doesn't apply). A cart line keeps its REGULAR
  price (`unitPrice` / `unitPriceText`) + `promo` (+ `promoChoice`); what's charged = `chargedLineOf` / `chargedLine`.
- **When it's judged:** at add-to-cart, on a channel / catalog re-price, every 15 s while the Sell screen has lines,
  on a new bootstrap, and at **Complete sale** (`PaymentScreen.record` → `cart.refreshPromos(soldAt)`; a change stops
  the sale with a message — the amount due moved — and `completeSale` refuses (`PromoChangedError`) if the lines don't
  match the promos at `soldAt`). **Clock:** the DEVICE clock, and that same instant is the sale's `sold_at` — the server
  judges the promo at `sold_at`, so both agree; like every sale time it is not offset-corrected (`serverClock` is DPoP
  only); a wrong clock is the server's CLOCK_DRIFT flag, a promo outside its window PRICE_MISMATCH (recorded as charged).
- **Senior/PWD + promo item (decision 6):** each eligible promo line shows both amounts (`compareScPwd`: "Promo …" vs
  "Senior/PWD 20%"), the cheaper one for the customer marked "Better for the customer", and "By law the customer gets
  the better of the two — the promo or the Senior/PWD 20% — never both". **No default**; Charge stays off until each is
  chosen (`promoChoiceProblem` in `cartProblem`). PROMO → promo price, `statutoryDiscountRate: 0` (VAT-exempt, no 20 %);
  SCPWD → regular price + 20 %. A different promo / price on the line clears the choice.
- **Payload** (`SaleLinePayload`, signed as usual): `unit_price` = as charged; a promo line adds `promo_id`,
  `regular_unit_price`, `promo_vs_scpwd` (the choice on a Senior/PWD line — SCPWD still sends the promo it passed over —
  else null). Lines without a promo send none of them (older servers unaffected).
- **Screens:** cart line = regular price struck through + promo price + "Promo: <name> · 15% off" chip; Payment lists
  the promo / the choice per line; customer display shows `qty × regular = regular amount` then "Promo: <name> −x".
  **Receipt** (shared `receipt-layout` item `promo`, like the web's `SalesReceipt`): the item at the regular price, then
  "Promo: <name>  −x"; the name comes from the receipt snapshot (`ReceiptLineSnapshot.promoName`), else the cached
  bootstrap, else "Store promo"; reprint totals use `promo_vs_scpwd` (`computePayloadTotals`).
- Self-test: `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/promo-selftest.ts`
  (in force / not yet / ended / end exclusive, overlap → lower, rounding, re-checks, choice, payload, pricing with rate 0).
- **Release:** additive both ways — this build works against an older server (no promos), and an older build against
  the new server sells at the regular price (the server flags those sales "was in force but not applied"). Raise the
  terminals' `min_app_version` to this build once the fleet runs it, so no tablet keeps selling at full price during promos.

### Attendance kiosk mode (`src/attendance/`, `modules/pos-face/`, `GamotERP/apps/pharma/docs/plans/hr-payroll-attendance.md` "Kiosk punch flow" + "Stage B — API contract" (b))

- **When:** HR binds the terminal as an attendance kiosk (web: HR → Attendance → Kiosks; company needs HR & Payroll).
  The ONLY signal is `GET /pos/attendance/kiosk` (200 = on; 403 `ATTENDANCE_KIOSK_OFF` / `MODULE_NOT_INCLUDED` = off) —
  no bootstrap field, no real-time notice. `refreshKiosk()` asks at start, after every bootstrap re-read (sync engine)
  and when the kiosk screen opens; the answer + employee list are cached per enrollment (`attendance_cache`, migration
  v4) so the kiosk works offline. **No PIN data is ever cached.**
- **Where** (attendance is POS-only since 2026-10-08 — the web kiosk was retired; `GamotERP/apps/pharma/docs/plans/
  attendance-pos-only.md`): on the LOCKED till (`LockedHome` in App.tsx) a kiosk terminal shows "Staff attendance"
  (default) | "Cashier sign-in"; with a cashier signed in, the top bar's **Attendance** section (only while the kiosk is
  ON) opens the same screen — it never offers selling.
- **Attendance-only tablets** (`terminal_type` ATTENDANCE_ONLY on the enrollment / bootstrap terminal —
  `isAttendanceOnlyTerminal`, attendanceKiosk.ts; absent = POS): added on Enroll POS (HR & Payroll; may sit at a
  warehouse) and bound as the location's kiosk automatically. The app has **no cashier**: top bar Attendance | Check-in
  | Settings (`ATTENDANCE_ONLY_SECTIONS`, `MainStack attendanceOnly` — home route Attendance); Settings hides catalog,
  invoice numbers, BIR and the Cashier group. The sync engine skips the catalog (the server reports
  `ATTENDANCE_ONLY_CATALOG_VERSION`) and the customer display; selling / cashier routes answer 403
  `ATTENDANCE_ONLY_TERMINAL`. The Enroll screen shows the type before enrolling.
- **Readiness:** a person without an attendance PIN AND a usable reference photo (`ready` false, `missing`) is greyed out
  ("Ask HR: no …") and can't start a punch; the PIN step's 409 `NOT_SET_UP` re-reads the list and says what's missing.
- **Lock:** NEW punches stop (banner "Attendance is paused", the grid disabled) while the device is revoked / the app too
  old / the subscription LOCKED / the lease expired — `attendanceBlockReason` (src/db/policy.ts), the selling rule minus
  the offline sale limits. Works through OVERDUE, like selling. Saved punches still upload. **A 403 `SUBSCRIPTION_LOCKED`
  from the PIN step is never "offline"** (code-review fix 2026-10-09): no punch, back to the list paused at once
  (`lockedByServer` → the banner) + a forced check-in (`syncEngine.syncNow({ checkVersions: true })`) so the stored
  license follows; only a genuine network failure (ApiError status 0) continues offline. The server flags any punch
  made on/after the company's lock day `SUBSCRIPTION_LOCKED` anyway (older builds; GamotERP `lib/attendance/record-punch.ts`).
- **Re-enroll keeps unsent punches** (`clearEnrollment` doesn't touch `attendance_punches`; photos stay), but they are
  signed with the revoked enrollment's key, which re-enrolling deletes — the server then refuses them (signature) and
  they show as "Not accepted" for HR to enter by hand. A revoked device can't upload them either (401), so Settings
  doesn't block re-enroll — its confirmation states the count (`unsentPunchCount`) and what happens.
- **Flow** (`src/screens/AttendanceKioskScreen.tsx`): name grid (initials, search) → Time in / Time out (the server's
  `suggested_kind` big; flipped locally after a punch until the next list) → PIN pad **online only** (`POST
  /pos/attendance/pin` → ticket + the server's challenge; not set up → "ask HR", no punch; a network failure here →
  continues offline; 403 `SUBSCRIPTION_LOCKED` → paused, see Lock) → camera (`LivenessCapture`) → saved + sent → "Time in recorded 8:02 AM" → list after 5 s. Idle
  45 s → back to the list. **Offline:** no PIN step (it can't be checked; the server flags `PIN_NOT_CHECKED`), a device
  challenge (2 distinct steps, random order, expo-crypto bytes).
- **Liveness** (`liveness.ts`, pure; ML Kit data from `modules/pos-face`): START = one face, |yaw| ≤ 12° held 0.5 s
  (frame 0); BLINK = both eyes ≥ 0.6 → both ≤ 0.3 → ≥ 0.6 (frame when they reopen); TURN_LEFT/RIGHT = own-side yaw ≥
  20° and ≥ 15° from START (frame then). 10 s for START, 8 s per step → FAILED ("Try again" / "Record anyway"; a frame is
  still taken for the failed step). **Own left = ML Kit `headEulerAngleY` POSITIVE** ("looking to the right of the
  camera"; contract: the nose moves to the raw image's right) — `OWN_LEFT_YAW_SIGN`, one place. The preview is mirrored,
  so "turn left" = toward the screen's left (arrow shown); saved frames are NOT mirrored. No camera / permission refused /
  engine error / camera not starting in 8 s → "Record without photo" (`SKIPPED` + `NO_CAMERA` | `PERMISSION_DENIED` |
  `ENGINE_FAILED` | `TIMEOUT`, no frames → server `KIOSK_PIN_ONLY` + `LIVENESS_SKIPPED`). A camera problem never blocks
  a punch (only readiness and the lock above do).
- **Frames:** taken from the analysed stream (~640×480) DURING the challenge: rotated upright, ≤ `capture.max_side_px`,
  JPEG at `jpeg_quality` lowered in steps of 10 until ≤ `max_frame_bytes`, fsync'd, sha256 computed natively. 2–3 per
  punch, index 0 = START. Plain files in app-private storage (`filesDir/attendance_frames/`, `allowBackup` false).
- **Queue** (`attendanceKiosk.ts`, table `attendance_punches`): `recordPunch` builds the payload (`punch.ts` — the
  server's `posPunchPayloadSchema` rules are re-checked first), signs `canonicalJson(payload)` with the device key
  (`jose.signPunchPayload`, same JWS as a sync op), and saves payload text + signature + frame list in ONE row BEFORE
  any upload (online too). `pushPunches()` (sync engine cycle, after the outbox; and the kiosk right after a punch, waiting
  ≤ 12 s for the answer) sends PENDING rows oldest first as multipart (`punch` = the stored signed text, never
  re-serialised; `signature`; `frame0..n` straight from disk): RECORDED / DUPLICATE → done + photos deleted from the
  tablet; 422 REJECTED, 400/409/413/415, a stored row that no longer matches its signature or a missing photo → kept as
  REJECTED (with photos) and listed on the kiosk ("Not accepted: N"); network / 5xx / 401 / 429 → stays PENDING (engine
  backoff); 403 `ATTENDANCE_KIOSK_OFF` → stays PENDING, retried after 15 min or once the kiosk answers ON. Leftover frame
  files (abandoned captures) are pruned after 10 min. The kiosk header shows "Unsent punches: N". Punches are NOT in the
  sales outbox / heartbeat `pending_ops`.
- **Native build:** `modules/pos-face` adds CameraX 1.6.0 (already in the APK via expo-camera) + ML Kit
  `com.google.mlkit:face-detection:16.1.7` **bundled** (~6.9 MB; works offline from first launch, no Play services; the
  unbundled `play-services-mlkit-face-detection` is ~0.8 MB but fetches its model through Play services). Autolinked from
  `modules/` — no prebuild needed for it, but a NEW dev client / release build is (`npx expo run:android`). In Expo Go the
  module is absent: punches are recorded without photos (`ENGINE_FAILED`). Kotlin compile check:
  `cd android && ./gradlew :pos-face:compileDebugKotlin`.
- Self-test: `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/attendance-selftest.ts`
  (evaluator with made-up face data, payload / queue serialisation, wording).

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

## Production checklist (not done yet)

- HTTPS only: remove `usesCleartextTraffic` (app.json / expo-build-properties) and add certificate pinning (with a
  backup pin) in the API client's network layer.
- Backend `POS_ATTESTATION_MODE=STRICT` (DEV is refused in production), `POS_APP_CERT_SHA256` = the release signing
  certificate digest (Play App Signing), `POS_TOKEN_SECRET` set, Play Integrity configured (cloud project number).
- Release build signed via Play App Signing, distributed through managed Google Play; tablets in Android Enterprise
  dedicated-device (kiosk) mode with automatic network time enforced.
- A real ESC/POS printer driver behind `src/printer/printer.ts` (currently `isAvailable() → false`, on-screen receipt).
- Check BIR POS accreditation (PTU per machine, e-journal) for offline selling with your accountant.
