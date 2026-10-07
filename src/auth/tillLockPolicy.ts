// The till's auto-lock rules, pure (no React Native) so scripts/till-lock-selftest.ts can check them. The wiring (timer,
// AppState, touches) is src/auth/tillLock.ts. Contract: "Cashier vs Sold By + idle lock" in @pos-api/contract —
// GamotERP/apps/pharma/docs/plans/sales-incentives.md "As built — cashier vs seller, idle lock".
import { DEFAULT_TILL_IDLE_LOCK_MINUTES, MAX_TILL_IDLE_LOCK_MINUTES, type PosBootstrap } from '@pos-api/contract';

import type { CartState } from '../sale/cart';

/**
 * Android reports the app as 'background' for ANY pause — the screen turning off, the home button, but also a system
 * dialog over the app (a camera-permission prompt). Leaving the app counts only once it has lasted this long, so
 * answering such a prompt doesn't lock the till; screen off / switching away for longer always does.
 */
export const BACKGROUND_GRACE_MS = 10_000;

/** How often the idle timer is checked while a cashier is signed in. */
export const IDLE_CHECK_INTERVAL_MS = 15_000;

/** The branch's setting from the cached bootstrap: 0 = never; absent / unreadable (older server) = the default. */
export function idleLockMinutesOf(bootstrap: PosBootstrap | null | undefined): number {
  const v = (bootstrap?.till as { idle_lock_minutes?: unknown } | undefined)?.idle_lock_minutes;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return DEFAULT_TILL_IDLE_LOCK_MINUTES;
  return Math.min(v, MAX_TILL_IDLE_LOCK_MINUTES);
}

// ---- the clock ------------------------------------------------------------------------------------------------------
// Decision (2026-10-09, code-review finding): the lock must not depend on the wall clock alone — setting the tablet's
// clock BACK would delay or skip it. No new native code: the monotonic source is `performance.now()` (React Native's
// HighResTimeStamp = C++ std::chrono::steady_clock = CLOCK_MONOTONIC on Android; process-relative, never goes back,
// unaffected by clock changes — the license clock uses it too, src/license/licenseEval.ts). CLOCK_MONOTONIC does NOT
// advance while the device is in deep sleep (screen off), so across a suspension it can only UNDER-count, never over-count.
// Hence elapsed = max(monotonic elapsed, wall elapsed): a backwards wall change can't pull it below the time the app was
// really awake, and the wall clock still covers the asleep part. Moving the wall clock FORWARD only locks sooner (the
// safe side). A negative wall elapsed = the clock was set back: for the BACKGROUND check (the device may have slept, so
// the monotonic part may be short) that locks at once; for the idle check (foreground = awake, monotonic is accurate) it
// is simply outweighed by the monotonic time. Without a monotonic source (`mono` null) a negative wall elapsed locks at
// once in both checks.

/** One reading of both clocks. `mono` = performance.now() (ms since the process started), null when unavailable. */
export interface ClockStamp {
  wall: number;
  mono: number | null;
}

/** How long since `since` (ms). Infinity = "treat as long ago" (the wall clock went back and nothing vouches for it). */
export function elapsedMs(since: ClockStamp, now: ClockStamp, opts?: { wallBackwardsLocks?: boolean }): number {
  const wall = now.wall - since.wall;
  const mono = since.mono !== null && now.mono !== null && now.mono >= since.mono ? now.mono - since.mono : null;
  if (wall < 0 && (mono === null || opts?.wallBackwardsLocks)) return Number.POSITIVE_INFINITY;
  return mono === null ? wall : Math.max(mono, wall);
}

/** Locks after `minutes` without a touch (elapsed per `elapsedMs` — monotonic-backed, see above). */
export function idleLockDue(lastActivity: ClockStamp, now: ClockStamp, minutes: number): boolean {
  if (minutes <= 0) return false;
  return elapsedMs(lastActivity, now) >= minutes * 60_000;
}

/**
 * Locks when the app has been in the background at least BACKGROUND_GRACE_MS (and auto-lock isn't off). The wall clock
 * set back while away locks at once (the monotonic clock may have slept through the absence).
 */
export function backgroundLockDue(backgroundSince: ClockStamp | null, now: ClockStamp, minutes: number): boolean {
  if (minutes <= 0 || backgroundSince === null) return false;
  return elapsedMs(backgroundSince, now, { wallBackwardsLocks: true }) >= BACKGROUND_GRACE_MS;
}

// ---- what counts as a touch on the cart ------------------------------------------------------------------------------

/** The parts of the cart only a person changes. Promos, stock hints, notices and the catalog version change by
 * themselves (bootstrap / catalog / stock refreshes) and must never restart the idle timer. */
export type CartActivitySlice = Pick<
  CartState,
  'lines' | 'client' | 'soldById' | 'txDiscount' | 'txDiscountReason' | 'statutory' | 'note' | 'channelId'
>;

const ACTIVITY_KEYS: readonly (keyof CartActivitySlice)[] = [
  'lines',
  'client',
  'soldById',
  'txDiscount',
  'txDiscountReason',
  'statutory',
  'note',
  'channelId',
];

/** Did a person-facing part of the cart change? (zustand replaces only what an action sets, so identity is enough.) */
export function isUserCartChange(prev: CartActivitySlice, next: CartActivitySlice): boolean {
  return ACTIVITY_KEYS.some((k) => !Object.is(prev[k], next[k]));
}

/** Shown on the locked till after an automatic lock. */
export function autoLockMessage(reason: 'IDLE' | 'BACKGROUND', minutes: number): string {
  return reason === 'IDLE'
    ? `Locked after ${minutes} minute${minutes === 1 ? '' : 's'} without a touch — unlock to continue. Choose Sold By again.`
    : 'Locked because the app was left or the screen turned off — unlock to continue. Choose Sold By again.';
}
