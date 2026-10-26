# Attendance kiosk mode — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/attendance/liveness.ts` — pure challenge evaluator
- `src/attendance/punch.ts` — payload, checks, queue serialisation, punch kinds + the punch-order rule
- `src/attendance/attendanceKiosk.ts` — kiosk on/off + employee cache, signed punch queue, upload
- `src/components/attendance/LivenessCapture.tsx`, `src/components/attendance/PinPad.tsx`
- `src/screens/AttendanceKioskScreen.tsx` — the kiosk screen
- `modules/pos-face/` — `index.ts`, `src/PosFaceModule.ts`, `src/PosFace.types.ts`
- `modules/pos-face/android/src/main/java/com/medsource/gamoterp/posface/` — `PosFaceCameraView.kt`, `PosFaceModule.kt`
- `src/db/policy.ts` — `attendanceBlockReason`; `src/db/localStore.ts` — `attendance_cache`, `attendance_punches`
- `src/device/jose.ts` — `signPunchPayload`
- `App.tsx` — `LockedHome`, `MainStack attendanceOnly`
- `scripts/attendance-selftest.ts` — self-test

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
- **Punch kinds** (app 1.3.0, user "go build" 2026-10-22; GamotERP `lib/attendance/countable.ts` = THE rule, mirrored in
  `punch.ts` because that file imports Prisma): Time in / Time out, **Start break / End break** (lunch, everyone — not
  counted) and **Transport Start / Transport End** (travel between branches, counted) ONLY for `multi_branch` employees
  (`punchKindsFor`; absent = false). Suggested (big button) = `suggestedKindOf`: BREAK_IN after BREAK_OUT, TRANSPORT_IN
  after TRANSPORT_OUT (multi-branch), else the server's `suggested_kind`; every other allowed kind is a smaller button
  below. After a punch the cached entry follows (`afterPunch`: `last_kind` = the punch, `suggested_kind` OUT when still on
  the clock) until the next list — so offline it suggests right too. Grid line: "At work" / "On break" / "Travelling"
  (`workStatusOf`). Server 400 `TRANSPORT_NOT_ALLOWED` at the PIN step → its message + list re-read; at upload → kept as
  REJECTED. `attendance_punches.kind` CHECK widened by local migration v5. **Release: backend first** — against an older server (no
  `last_kind` / `multi_branch`, IN/OUT-only schema) the break buttons still show but the PIN step refuses a break punch
  (400, shown) and an OFFLINE break punch comes back REJECTED at upload (400, kept as "Not accepted"); IN/OUT keep working. Older apps (≤ 1.2.0) against the new server: unchanged (IN/OUT only).
- **Punch ORDER** (app 1.4.x, branch `feature/attendance-punch-order`; server: GamotERP `docs/plans/attendance-punch-order.md`, `lib/attendance/punch-order.ts` = THE rule, mirrored ONCE in `punch.ts` `allowedKindsAfter`):
  OFF (none / OUT / last punch older than 16 h) → IN only; WORKING (IN / BREAK_IN / TRANSPORT_IN) → OUT, BREAK_OUT,
  TRANSPORT_OUT (multi-branch only); ON_BREAK → BREAK_IN only; IN_TRANSPORT → TRANSPORT_IN only. The kiosk's kind step
  shows ONLY the allowed buttons (`allowedKindsFor`; big button = `suggestedAmong`). "Last known state" = the employee's
  cached `punch_state` (server list: last_kind + since) advanced by this tablet's own punches: `afterPunch` after each
  save, and `withLocalPunches` on every list refresh (PENDING queue rows NEWER than the server's `since` are re-applied, so a
  list read can't undo an unsent punch). The state is re-judged with the device clock at render time, so a shift open > 16 h
  offers IN again offline (grid line also reads off). Limit = `DEFAULT_OPEN_SHIFT_LIMIT_HOURS` (16; the list's
  `open_shift_limit_hours` is not cached). Online 409 `PUNCH_OUT_OF_ORDER` at the PIN step → the server's message on the kind
  step + list re-read (the cached state follows). An OFFLINE punch is always uploaded; the server flags a misfit
  `OUT_OF_ORDER` (never refused). **Older server** (no `punch_state` on the list) → every kind shown as before (the PIN
  step then gets the 409 on a bad order, handled the same way). Self-test covers every transition, the 16 h rule, night / split
  shift, transport for single-branch, local queue newer than the synced state.
- **Flow** (`src/screens/AttendanceKioskScreen.tsx`): name grid (initials, search) → the kind (above) → PIN pad **online only** (`POST
  /pos/attendance/pin` → ticket + the server's challenge; not set up → "ask HR", no punch; a network failure here →
  continues offline; 403 `SUBSCRIPTION_LOCKED` → paused, see Lock) → camera (`LivenessCapture`) → saved + sent → "Time in recorded 8:02 AM" → list after 5 s. Idle
  45 s → back to the list. **Offline:** no PIN step (it can't be checked; the server flags `PIN_NOT_CHECKED`), a device
  challenge (2 distinct steps, random order, expo-crypto bytes).
- **Liveness** (`liveness.ts`, pure; ML Kit data from `modules/pos-face`): START = one face, |yaw| ≤ 12° held 0.5 s
  (frame 0); BLINK = both eyes ≥ 0.6 → both ≤ 0.3 → ≥ 0.6 (frame when they reopen); TURN_LEFT/RIGHT = own-side yaw ≥
  20° and ≥ 15° from START (frame then). 10 s for START, 8 s per step → FAILED (a frame is
  still taken for the failed step). **Online (ticketed) punch = the check MUST pass** (server release 2.28: failed /
  skipped / no photo → 422 `LIVENESS_FAILED`, nothing stored, ticket stays usable): `LivenessCapture requirePass` shows only
  "Try again" / "Cancel" (no "Record anyway" / "Record without photo"; camera trouble → "fix the camera or ask your
  manager"). **Offline** punches keep "Try again" / "Record anyway" and "Record without photo" (flagged for HR). **Own left = ML Kit `headEulerAngleY` POSITIVE** ("looking to the right of the
  camera"; contract: the nose moves to the raw image's right) — `OWN_LEFT_YAW_SIGN`, one place. The preview is mirrored,
  so "turn left" = toward the screen's left (arrow shown); saved frames are NOT mirrored. No camera / permission refused /
  engine error / camera not starting in 8 s → (offline only) "Record without photo" (`SKIPPED` + `NO_CAMERA` | `PERMISSION_DENIED` |
  `ENGINE_FAILED` | `TIMEOUT`, no frames → server `KIOSK_PIN_ONLY` + `LIVENESS_SKIPPED`). Offline, a camera problem never blocks
  a punch (only readiness and the lock above do); online it blocks until the camera works.
- **Frames:** taken from the analysed stream (~640×480) DURING the challenge: rotated upright, ≤ `capture.max_side_px`,
  JPEG at `jpeg_quality` lowered in steps of 10 until ≤ `max_frame_bytes`, fsync'd, sha256 computed natively. 2–3 per
  punch, index 0 = START. Plain files in app-private storage (`filesDir/attendance_frames/`, `allowBackup` false).
- **Queue** (`attendanceKiosk.ts`, table `attendance_punches`): `recordPunch` builds the payload (`punch.ts` — the
  server's `posPunchPayloadSchema` rules are re-checked first), signs `canonicalJson(payload)` with the device key
  (`jose.signPunchPayload`, same JWS as a sync op), and saves payload text + signature + frame list in ONE row BEFORE
  any upload (online too). `pushPunches()` (sync engine cycle, after the outbox; and the kiosk right after a punch, waiting
  ≤ 12 s for the answer) sends PENDING rows oldest first as multipart (`punch` = the stored signed text, never
  re-serialised; `signature`; `frame0..n` straight from disk): RECORDED / DUPLICATE → done + photos deleted from the
  tablet; 422 REJECTED, 404 (person no longer active), 400/409/413/415, a stored row that no longer matches its signature or a missing photo → kept as
  REJECTED (with photos; never retried) and listed on the kiosk ("Not accepted: N"). An ONLINE (ticketed) punch refused
  with 422 `LIVENESS_FAILED` is **DISCARDED** (user decision 2026-10-22, `discardsRefusal` / `markDiscarded`): status
  DISCARDED, photos deleted at once, not counted, not listed under "Not accepted" (nothing was stored on the server; the
  ticket is still unused); the kiosk shows the server's message and returns to the camera with the SAME ticket + steps
  (`isLivenessRefusal` = DISCARDED + that code). Migration v5 also discards 1.2.0's kept rows of that kind. An offline
  punch is never discarded; network / 5xx / 401 / 429 → stays PENDING (engine
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
  (evaluator with made-up face data, payload / queue serialisation, punch kinds + suggestion + offline flip, punch order, the discarded online refusal, wording).
