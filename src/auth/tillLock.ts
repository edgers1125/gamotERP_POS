// The till's auto-lock + the sticky Sold By reset (GamotERP/apps/pharma/docs/plans/sales-incentives.md "As built — cashier
// vs seller, idle lock"; contract "Cashier vs Sold By + idle lock"). Rules are pure in ./tillLockPolicy.ts.
//
// * The till locks (cashierSession.lock(), exactly like the Lock button) after the branch's `till.idle_lock_minutes`
//   minutes without a touch, and when the app goes to the background / the screen turns off (after
//   BACKGROUND_GRACE_MS — see there). 0 = neither. Only while a cashier is signed in.
// * A touch = any touch start in the app window (App.tsx's root view), inside a Sheet / dialog (they are separate native
//   windows — each calls markTillActivity), a keystroke in a TextField, or a change a PERSON makes to the cart (lines,
//   client, Sold By, discounts, Senior/PWD, note, channel — `isUserCartChange`). Changes the app makes by itself (promos /
//   stock / catalog re-checks after a background bootstrap or heartbeat — `isSystemCartUpdate`) never count, or a till
//   left alone while the real-time channel is down would never lock.
// * Time is measured on both the wall clock and the monotonic clock (`performance.now()`), so setting the tablet's
//   clock back can't delay or skip a lock — see "the clock" in ./tillLockPolicy.ts.
// * Locking, signing out or another cashier signing in clears the chosen Sold By (the cart keeps it across sales
//   otherwise — "sticky" — and never fills it in by itself).
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';

import { isSystemCartUpdate, useCart } from '../sale/cart';
import { cashierSession, useCashier } from './cashierSession';
import {
  autoLockMessage,
  BACKGROUND_GRACE_MS,
  backgroundLockDue,
  IDLE_CHECK_INTERVAL_MS,
  idleLockDue,
  isUserCartChange,
  type ClockStamp,
} from './tillLockPolicy';

function stamp(): ClockStamp {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return { wall: Date.now(), mono: typeof p?.now === 'function' ? p.now() : null };
}

let lastActivity: ClockStamp = stamp();

/** Something happened on the till — restarts the idle timer. Cheap; call it freely. */
export function markTillActivity(): void {
  lastActivity = stamp();
}

/** Why the till last locked by itself (shown on the locked till until someone signs in). */
export const useTillLockNotice = create<{ message: string | null }>(() => ({ message: null }));

function autoLock(reason: 'IDLE' | 'BACKGROUND', minutes: number): void {
  if (!useCashier.getState().cashier) return;
  cashierSession.lock();
  useTillLockNotice.setState({ message: autoLockMessage(reason, minutes) });
}

/** Mounted once (App.tsx Shell) for as long as the device is enrolled. `minutes` = the branch's setting (0 = off). */
export function useTillAutoLock(minutes: number): void {
  // The sticky seller: cleared whenever the signed-in cashier goes away or changes; a person's cart change is activity.
  useEffect(() => {
    markTillActivity();
    const offCashier = useCashier.subscribe((s, prev) => {
      const before = prev.cashier?.userId ?? null;
      const now = s.cashier?.userId ?? null;
      if (before !== null && now !== before) useCart.getState().setSoldBy(null);
      if (now !== null && before === null) {
        useTillLockNotice.setState({ message: null });
        markTillActivity();
      }
    });
    const offCart = useCart.subscribe((s, prev) => {
      if (!isSystemCartUpdate() && isUserCartChange(prev, s)) markTillActivity();
    });
    return () => {
      offCashier();
      offCart();
    };
  }, []);

  useEffect(() => {
    if (minutes <= 0) return;
    markTillActivity();
    const tick = setInterval(() => {
      if (useCashier.getState().cashier && idleLockDue(lastActivity, stamp(), minutes)) autoLock('IDLE', minutes);
    }, IDLE_CHECK_INTERVAL_MS);

    let backgroundSince: ClockStamp | null = AppState.currentState === 'background' ? stamp() : null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (s: AppStateStatus) => {
      if (s === 'background') {
        backgroundSince ??= stamp();
        // JS timers may not run while backgrounded — the check on return below is the real guard.
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          if (backgroundLockDue(backgroundSince, stamp(), minutes)) autoLock('BACKGROUND', minutes);
        }, BACKGROUND_GRACE_MS + 500);
      } else if (s === 'active') {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = null;
        const now = stamp();
        if (backgroundLockDue(backgroundSince, now, minutes)) autoLock('BACKGROUND', minutes);
        else if (useCashier.getState().cashier && idleLockDue(lastActivity, now, minutes)) autoLock('IDLE', minutes);
        backgroundSince = null;
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => {
      clearInterval(tick);
      if (graceTimer) clearTimeout(graceTimer);
      sub.remove();
    };
  }, [minutes]);
}
