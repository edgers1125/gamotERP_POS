# Cashier vs Sold By + till auto-lock — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/auth/tillLock.ts` — idle / background auto-lock, sticky Sold By reset
- `src/auth/tillLockPolicy.ts` — `isUserCartChange`, `ACTIVITY_KEYS`, the clock
- `src/auth/cashierSession.ts` — `lock()`
- `src/components/sale/SoldByDialog.tsx` — "Who sold it?"; `src/components/sale/ui.tsx` — `Sheet`, `tillTouch`
- `src/components/shell/VoidDialog.tsx` — a Modal that must call `tillTouch`
- `src/sale/cart.ts` — `systemUpdate`, `reset()` keeps Sold By; `src/sale/checkout.ts` — receipt snapshot names
- `App.tsx` — `SafeFrame` touch capture, `LockedHome`
- `scripts/till-lock-selftest.ts` — self-test

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
- **Auto-lock:** bootstrap `till.idle_lock_minutes` (per COMPANY since 2026-10-08: admin portal › Companies › "Till auto-lock" — was a branch setting under Branches › Manage POS; 0 = off; absent =
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
