# Prescription (Rx) step — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS). Server side + API contract:
GamotERP `apps/pharma/docs/plans/pos-rx-step.md` and `backend/src/pos-api/contract.ts` section "Prescriptions — the POS Rx
step" (app 1.5.0; needs the server of release 2.54 — older servers have none of the routes).

## File map

- `src/sale/prescription.ts` — PURE rules: Rx lines + pieces per model, the draft (`RxDraft` NEW | FILL), the named-client
  rule, the local checks (`localRxIssues`, server codes / paths / wording), the payload (`prescriptionPayload`), the check
  request, issue → field (`rxIssueField`), sync-log titles (`rxIssueTitle`), doctor search
- `src/sale/doctors.ts` — the doctors cache (`useDoctors`, `doctorsCache`: load / refresh / refreshIfDifferent / add /
  fillMissing, `licenseTakenDoctor`)
- `src/sale/cart.ts` — CartLine `modelId` / `modelName` / `rxRequired` / `dangerousDrug`, cart `rx` + `setRx`, `rxLinesOf`,
  `cartProblem` (Rx cart → no walk-in)
- `src/sale/checkout.ts` — `localPrescriptionIssues`, `checkCartPrescription` (local → online check), `completeSale` adds
  `prescription` and refuses on a local issue
- `src/api/client.ts` — `prescriptionDoctors`, `createPrescriptionDoctor`, `fillPrescriptionDoctor` (PATCH),
  `openPrescriptions`, `checkPrescription`; `ApiError.details` (the 409's `doctor`)
- `src/db/localStore.ts` — `getDoctors` / `saveDoctors` (meta key `doctors_cache`, cleared on (re-)enroll)
- `src/sync/syncEngine.ts` — hello `versions.doctors`, `state` / `changed` kind `'doctors'`, deferred retry, Sync now
- `src/screens/PrescriptionScreen.tsx`, `src/components/rx/` — the step's UI (Sell → Prescription → Payment)
- `scripts/rx-selftest.ts` — self-test of `prescription.ts` (run like the other self-tests)

## Rules

- **When:** any cart line with catalog `rx_required` or `is_dangerous_drug` (a DD is always Rx). Sell's Charge goes to the
  Prescription screen first; the client must be the patient — existing or registered new client with first + last name;
  "No client details" is disabled (RX_WALK_IN_REASON).
- **Pieces** = quantity × pack_quantity, summed per product model (several pack sizes fill one prescription item).
- **New prescription:** doctor from the cached list ONLY (decision P2 — the APK never sends typed prescriber text);
  `usable` false → "Fill in missing details" first (online). Date ≤ sale day, ≤ 180 days old (DD 30). Quantity prescribed
  per Rx model ≥ the cart's pieces. PTR / S2 typed only when the doctor has none (sent only then). DD: S2, form serial,
  patient address (typed, or the client's on record / the Senior/PWD card's complete address). Serial uniqueness is only
  checked online / at sync.
- **Fill an open prescription:** online only (list fetched during THIS sale, kept in the cart draft; its remaining pieces
  are re-checked locally). Payload = `{ prescription_id }` only. Changing the client drops a FILL draft.
- **Online vs offline (P3):** before charging, the Prescription screen's Continue and the Payment screen's Complete run
  `checkCartPrescription`: local checks first, then — online with an online cashier — `POST /pos/prescriptions/check`
  (`ok: false` keeps the cashier on the step). Network failure / 5xx = "unchecked" → the sale may go ahead (the server
  re-checks at sync and NEVER refuses — `PRESCRIPTION_ISSUE` exceptions with `code`). Adding / filling in a doctor and
  open prescriptions need a connection.
- **Doctors cache (P4):** the whole active list (≤ 5,000, `truncated` beyond) in one meta row. `GET /pos/prescription-doctors`
  needs an ONLINE cashier: a newer server version seen without one waits and is retried by the sync cycle (60 s), like
  the approver lists. The realtime hello ALWAYS sends `versions.doctors` (null until first fetched) — that opts in to
  `changed` kind `'doctors'` (attendance-only tablets don't). Add / fill-missing put the doctor in the cache at once, then
  re-fetch the list. A doctor gone from a refreshed list (deactivated) can't be used: RX_DOCTOR_NOT_FOUND.
- **Results:** the SALE sync result's `prescription` (reference) shows on the Receipt screen; PRESCRIPTION_ISSUE exceptions
  show `rxIssueTitle(code)` + the server's message on the Receipt banner and the Check-in screen.
