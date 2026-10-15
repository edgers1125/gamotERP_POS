# Cash drawer — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/drawer/cashDrawer.ts` — types, `drawerTally`, `drawerSellProblem`
- `src/drawer/useCashDrawer.ts` — open session as UI state, `useDrawerGate`
- `src/screens/CashDrawerScreen.tsx` — the Cash drawer section
- `src/components/drawer/DrawerGateBanner.tsx` — selling-gate banner
- `src/db/localStore.ts` — `openDrawer` / `recordDrawerMovement` / `closeDrawer`, `recordSale` gate; `src/db/schema.ts` — migration v3
- `src/screens/RefundScreen.tsx` — writes `local_refunds`

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
