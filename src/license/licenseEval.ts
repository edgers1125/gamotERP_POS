// Judging the stored lease now (used by src/db/localStore.ts — sellingBlockedReason and recordSale — and by
// src/license/license.ts). Pure rules in ./lease.ts; this file adds the clock and a verification memo.
//
// The clock (contract step 3, plan Part C "clock tampering"):
//   now = max( device time + server clock offset (src/device/serverClock.ts),
//              the stored floor (last trusted server time),
//              the last `now` of this app process + the MONOTONIC time elapsed since (performance.now) )
// The floor is the newest lease's signed `issued_at` when it arrives (server authority — it may LOWER a floor that a
// wrong device clock had pushed ahead, which heals at the next check-in) and is otherwise raised to `now` as time goes
// by (persisted by localStore at most once a minute). So setting the tablet's clock back never moves "now" back:
// below the floor it stands still, and while the app keeps running it still advances with the monotonic clock.
import type { PosLicensePublicKey } from '@pos-api/contract';

import { serverClock } from '../device/serverClock';
import { evaluateLicense, leaseNow, verifyLease, type LeaseIds, type LeaseVerifyResult, type LicenseEvaluation, type LicenseRecord } from './lease';
import { licenseKeys } from './licenseKeys';

/** Persist a raised floor only when it moved at least this much (a DB write per minute at most). */
export const FLOOR_PERSIST_STEP_MS = 60_000;

function perfNow(): number | null {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : null;
}

let mono: { baseMs: number; perfAt: number } | null = null;

/** Forget the in-process monotonic anchor (the floor was reset from a fresh lease). */
export function resetLicenseClock(): void {
  mono = null;
}

/** "Now" for the lease, never below `floorMs` nor below the last value this process returned (+ elapsed). */
export async function licenseNowMs(floorMs: number): Promise<number> {
  let now = leaseNow(await serverClock.nowMs(), floorMs);
  const p = perfNow();
  if (p !== null) {
    if (mono) now = Math.max(now, mono.baseMs + Math.max(0, p - mono.perfAt));
    mono = { baseMs: now, perfAt: p };
  }
  return now;
}

// Signature verification is pure but not free (~ms in Hermes): memo by (lease, keys, ids).
let memo: { key: string; result: LeaseVerifyResult } | null = null;

export function verifyStoredLease(lease: string, keys: ReturnType<typeof licenseKeys>, ids: LeaseIds): LeaseVerifyResult {
  const key = `${lease}|${keys.map((k) => `${k.kid}:${k.x}`).join(',')}|${ids.companyId}/${ids.terminalId}/${ids.deviceId}`;
  if (memo && memo.key === key) return memo.result;
  const result = verifyLease(lease, keys, ids);
  memo = { key, result };
  return result;
}

/** The stored record judged now. `serverKeys` = bootstrap `license_public_keys` (trusted only in __DEV__ builds). */
export async function evaluateStoredLicense(
  record: LicenseRecord,
  floorMs: number,
  ids: LeaseIds | null,
  serverKeys: readonly PosLicensePublicKey[] | null | undefined,
): Promise<{ evaluation: LicenseEvaluation; nowMs: number }> {
  const keys = licenseKeys(serverKeys);
  const nowMs = await licenseNowMs(floorMs);
  const evaluation = evaluateLicense({
    record,
    keys,
    ids,
    nowMs,
    verify: ids ? (lease) => verifyStoredLease(lease, keys, ids) : undefined,
  });
  return { evaluation, nowMs };
}
