# Attendance kiosk mode — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/attendance/liveness.ts` — pure challenge evaluator
- `src/attendance/punch.ts` — payload, checks, queue serialisation
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
- **Flow** (`src/screens/AttendanceKioskScreen.tsx`): name grid (initials, search) → Time in / Time out (the server's
  `suggested_kind` big; flipped locally after a punch until the next list) → PIN pad **online only** (`POST
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
  REJECTED (with photos; never retried) and listed on the kiosk ("Not accepted: N"). A ticketed punch rejected with
  `LIVENESS_FAILED` (`isLivenessRefusal`, punch.ts; code kept in the stored result) is NOT shown as "tell your manager":
  the kiosk shows the server's message and returns to the camera with the SAME ticket + steps (still listed under "Not accepted"); network / 5xx / 401 / 429 → stays PENDING (engine
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
