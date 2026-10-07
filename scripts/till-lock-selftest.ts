// Self-test of the till's auto-lock rules and the receipt's staff line — pure code, no device or server:
//   * src/auth/tillLockPolicy.ts — the branch setting from bootstrap (`till`, default / bounds), the idle timer, the
//     background grace, the clock (monotonic-backed: a clock set back can't delay a lock), what counts as a touch on
//     the cart (background promo / stock / catalog refreshes don't), the locked-till wording;
//   * src/sale/promos.ts samePromoList — a re-read bootstrap with the same promos is "no change" (cart.setPromos no-op);
//   * @shared/receipt-layout staffLine — "Cashier: X · Sold by: Y" (GamotERP docs/plans/sales-incentives.md "As built —
//     cashier vs seller, idle lock").
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api / @shared aliases from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/till-lock-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import { DEFAULT_TILL_IDLE_LOCK_MINUTES, MAX_TILL_IDLE_LOCK_MINUTES, type PosBootstrap } from '@pos-api/contract';
import { staffLine } from '@shared/receipt-layout';

import type { PosPromo } from '@pos-api/contract';

import {
  autoLockMessage,
  BACKGROUND_GRACE_MS,
  backgroundLockDue,
  elapsedMs,
  idleLockDue,
  idleLockMinutesOf,
  isUserCartChange,
  type CartActivitySlice,
  type ClockStamp,
} from '../src/auth/tillLockPolicy';
import { promosOf, samePromoList } from '../src/sale/promos';

declare const process: { exitCode?: number };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const boot = (till: unknown) => ({ till }) as unknown as PosBootstrap;

// ---- the setting ------------------------------------------------------------------------------------------------
check('no bootstrap → default 20', idleLockMinutesOf(null) === DEFAULT_TILL_IDLE_LOCK_MINUTES && DEFAULT_TILL_IDLE_LOCK_MINUTES === 20);
check('older server (no till) → default', idleLockMinutesOf(boot(undefined)) === DEFAULT_TILL_IDLE_LOCK_MINUTES);
check('0 = off', idleLockMinutesOf(boot({ idle_lock_minutes: 0 })) === 0);
check('45 kept', idleLockMinutesOf(boot({ idle_lock_minutes: 45 })) === 45);
check('above the max → capped', idleLockMinutesOf(boot({ idle_lock_minutes: 9999 })) === MAX_TILL_IDLE_LOCK_MINUTES);
check('negative / fraction / text → default', [-1, 2.5, '10'].every((v) => idleLockMinutesOf(boot({ idle_lock_minutes: v })) === DEFAULT_TILL_IDLE_LOCK_MINUTES));

// ---- idle timer -------------------------------------------------------------------------------------------------
const t0 = Date.UTC(2026, 9, 7, 2, 0, 0);
const min = 60_000;
const m0 = 5_000; // performance.now() at t0 (ms since the app process started)
/** Both clocks `dt` later; `wallShift` = a change of the tablet's clock on top; `mono` false = no monotonic source. */
const at = (dt: number, wallShift = 0, mono = true): ClockStamp => ({ wall: t0 + dt + wallShift, mono: mono ? m0 + dt : null });
const start = at(0);
check('19:59 idle at 20 → not yet', !idleLockDue(start, at(20 * min - 1000), 20));
check('20:00 idle at 20 → lock', idleLockDue(start, at(20 * min), 20));
check('off never locks', !idleLockDue(start, at(1000 * min), 0));
check('1 minute setting', idleLockDue(start, at(min), 1) && !idleLockDue(start, at(min - 1), 1));
// The clock (code-review finding: setting the clock back delayed / skipped the lock).
check('clock set back 30 min — 20 real minutes still lock (monotonic)', idleLockDue(start, at(20 * min, -30 * min), 20));
check('clock set back 30 min — 19 real minutes: not yet', !idleLockDue(start, at(19 * min, -30 * min), 20));
check('clock set back, no monotonic source → lock now', idleLockDue(at(0, 0, false), at(min, -30 * min, false), 20));
check('no monotonic source, normal time still counts', idleLockDue(at(0, 0, false), at(20 * min, 0, false), 20) && !idleLockDue(at(0, 0, false), at(19 * min, 0, false), 20));
check('clock set forward → locks sooner (safe side)', idleLockDue(start, at(min, 25 * min), 20));
check('monotonic value older than the stamp (new process) → wall clock decides', elapsedMs({ wall: t0, mono: 9e9 }, { wall: t0 + 5 * min, mono: 10 }) === 5 * min);

// ---- background -------------------------------------------------------------------------------------------------
check('still foreground → no', !backgroundLockDue(null, at(0), 20));
check('a short pause (permission prompt) → no', !backgroundLockDue(start, at(BACKGROUND_GRACE_MS - 1), 20));
check('screen off past the grace → lock', backgroundLockDue(start, at(BACKGROUND_GRACE_MS), 20));
check('auto-lock off → background never locks', !backgroundLockDue(start, at(60 * min), 0));
// Deep sleep: CLOCK_MONOTONIC stands still, the wall clock doesn't → the wall time decides.
check('asleep 1 h (monotonic stood still) → lock', backgroundLockDue(start, { wall: t0 + 60 * min, mono: m0 + 200 }, 20));
check('clock set back while away → lock at once', backgroundLockDue(start, at(2_000, -60 * min), 20));
check('clock set back while away, no monotonic → lock at once', backgroundLockDue(at(0, 0, false), at(2_000, -60 * min, false), 20));
check('15 s awake in Settings + clock set back → lock', backgroundLockDue(start, at(15_000, -10 * min), 20));

// ---- what counts as a touch on the cart (code-review finding: background refreshes reset the idle timer) ----------
type CartLike = CartActivitySlice & { promos: PosPromo[]; stock: Record<number, number>; notice: string | null; catalogVersion: string | null };
const base = {
  lines: [],
  client: { kind: 'UNSET' },
  soldById: null,
  txDiscount: { mode: 'AMOUNT', value: '' },
  txDiscountReason: '',
  statutory: null,
  note: '',
  channelId: 1,
  promos: [],
  stock: {},
  notice: null,
  catalogVersion: null,
} as unknown as CartLike;
const patched = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as CartLike;
check('same state → no touch', !isUserCartChange(base, { ...base }));
check('new promos array (heartbeat → bootstrap re-read) → no touch', !isUserCartChange(base, patched({ promos: [] })));
check('stock hint / notice / catalog version → no touch', !isUserCartChange(base, patched({ stock: { 1: 3 }, notice: 'x', catalogVersion: 'v2' })));
check('lines changed → touch', isUserCartChange(base, patched({ lines: [] })));
check('Sold By picked → touch', isUserCartChange(base, patched({ soldById: 7 })));
check(
  'client / discount / reason / Senior-PWD / note / channel → touch',
  [{ client: { kind: 'WALK_IN' } }, { txDiscount: { mode: 'PERCENT', value: '5' } }, { txDiscountReason: 'loyal' }, { statutory: {} }, { note: 'n' }, { channelId: 2 }].every((p) =>
    isUserCartChange(base, patched(p)),
  ),
);

// ---- same promos re-read → cart.setPromos is a no-op ---------------------------------------------------------------
const promoJson = {
  id: 3,
  name: 'Oct sale',
  discount_type: 'PERCENT_OFF',
  discount_value: '15',
  starts_at: '2026-10-01T00:00:00+08:00',
  ends_at: '2026-11-01T00:00:00+08:00',
  sku_ids: [1, 2],
};
const read = (promos: unknown[]) => promosOf({ promos } as never);
const reread1 = read([JSON.parse(JSON.stringify(promoJson))]);
const reread2 = read([JSON.parse(JSON.stringify(promoJson))]);
const reordered = read([{ sku_ids: [1, 2], ends_at: promoJson.ends_at, starts_at: promoJson.starts_at, discount_value: '15', discount_type: 'PERCENT_OFF', name: 'Oct sale', id: 3 }]);
check('re-read bootstrap: new objects, same promos → same', reread1 !== reread2 && reread1.length === 1 && samePromoList(reread1, reread2));
check('key order ignored', samePromoList(reread1, reordered));
check('both empty → same', samePromoList([], []));
check('ended early (ends_at changed) → different', !samePromoList(reread1, read([{ ...promoJson, ends_at: '2026-10-09T00:00:00+08:00' }])));
check('a promo published → different', !samePromoList(reread1, read([promoJson, { ...promoJson, id: 4 }])));
check('SKU list changed → different', !samePromoList(reread1, read([{ ...promoJson, sku_ids: [1] }])));

// ---- wording ----------------------------------------------------------------------------------------------------
check('idle message', autoLockMessage('IDLE', 20).startsWith('Locked after 20 minutes without a touch'), autoLockMessage('IDLE', 20));
check('idle message, 1 minute', autoLockMessage('IDLE', 1).startsWith('Locked after 1 minute without'));
check('background message', autoLockMessage('BACKGROUND', 20).includes('the screen turned off'));

// ---- receipt staff line ------------------------------------------------------------------------------------------
check('both names', staffLine('Ana Cruz', 'Ben Reyes') === 'Cashier: Ana Cruz · Sold by: Ben Reyes', staffLine('Ana Cruz', 'Ben Reyes'));
check('same person twice', staffLine('Ana Cruz', 'Ana Cruz') === 'Cashier: Ana Cruz · Sold by: Ana Cruz');
check('only the seller known', staffLine(null, 'Ben Reyes') === 'Sold by: Ben Reyes');
check('only the cashier known', staffLine(' Ana ', '  ') === 'Cashier: Ana');
check('neither → null', staffLine(undefined, null) === null);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
