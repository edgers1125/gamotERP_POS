// The POS app license lease on the device (GamotERP/apps/pharma/docs/plans/pos-license-and-billing-lock.md Part C;
// contract.ts "License lease"). Stores what check-ins say (src/license/licenseEvents.ts signals from api/client.ts and
// sync/realtime.ts) in the local DB (meta `license`, src/db/localStore.ts); the selling rule itself is
// src/db/policy.ts `blockReason` with the evaluation from src/license/licenseEval.ts.
//
// Rules:
//   * A check-in with `license` → `seen` (enforcement starts). state LOCKED → `locked`, stored lease DISCARDED.
//     state OK / OVERDUE → `locked` cleared; its lease is verified (pinned keys, this device's ids) and kept when it is
//     newer (larger issued_at) than the stored one; a fresh lease also resets the clock floor to its signed issued_at.
//     A lease that doesn't verify is logged and ignored (the stored one stays).
//   * A check-in WITHOUT `license` (older server, or no signing key configured on the server) → logged, nothing changes.
//     ROLLOUT GRACE: until the first `license` arrives nothing is enforced (`seen` false → 'NOT_ENFORCED'). Once seen,
//     it stays seen (sticky), so stripping the field later can't switch enforcement off.
//   * 403 SUBSCRIPTION_LOCKED (REST) / realtime close 4402 → `locked` + lease discarded (no key needed: the server said
//     so online). A later success of a call a locked company is refused (catalog, session, display…) → `locked`
//     cleared (the server isn't locked any more; selling then needs a valid lease again if leases are issued).
import type { PosLicense, PosLicensePublicKey } from '@pos-api/contract';

import { localStore } from '../db/localStore';
import { Mutex } from '../db/mutex';
import { verifyLease, type LicenseRecord } from './lease';
import { resetLicenseClock } from './licenseEval';
import { onLicenseSignal, type LicenseSignal } from './licenseEvents';
import { licenseKeys } from './licenseKeys';

const lock = new Mutex();
let loggedNoLicense = false;

function log(msg: string): void {
  if (__DEV__) console.log(`[license] ${msg}`);
}

async function idsNow() {
  const [enrollment, bootstrap] = await Promise.all([localStore.getEnrollment(), localStore.getBootstrap().catch(() => null)]);
  const terminal = bootstrap?.terminal ?? enrollment?.terminal ?? null;
  if (!enrollment || !terminal) return null;
  return { deviceId: enrollment.device_id, terminalId: terminal.id, companyId: terminal.company.id };
}

async function ingestCheckIn(license: PosLicense | undefined, source: string, publicKeys: PosLicensePublicKey[] | undefined): Promise<boolean> {
  if (license === undefined) {
    if (!loggedNoLicense) {
      loggedNoLicense = true;
      console.warn(`[license] the server sent no license with ${source} (no signing key configured, or an older server) — not enforced`);
    }
    return false;
  }
  const rec = await localStore.getLicenseRecord();
  const next: LicenseRecord = {
    ...rec,
    seen: true,
    last: { state: license.state, overdue_since: license.overdue_since ?? null, lock_on: license.lock_on ?? null, at: new Date().toISOString() },
  };
  let floorMs: number | undefined;
  if (license.state === 'LOCKED') {
    next.locked = true;
    next.lease = null; // contract: discard the stored lease, stop selling now
  } else {
    next.locked = false;
    if (typeof license.lease === 'string' && license.lease) {
      const ids = await idsNow();
      const bootstrapKeys = publicKeys ?? (await localStore.getBootstrap().catch(() => null))?.license_public_keys;
      const keys = licenseKeys(bootstrapKeys);
      const incoming = ids ? verifyLease(license.lease, keys, ids) : null;
      if (!incoming || !incoming.ok) {
        console.warn(`[license] ignoring a lease from ${source}: ${incoming ? `${incoming.reason} — ${incoming.detail}` : 'device not enrolled'}`);
      } else {
        const stored = rec.lease && ids ? verifyLease(rec.lease, keys, ids) : null;
        if (!stored || !stored.ok || incoming.issuedAtMs > stored.issuedAtMs) {
          next.lease = license.lease;
          // The signed issued_at is the server's time when it signed: the trusted floor for "now" (may lower a floor a
          // wrong device clock had pushed ahead).
          floorMs = incoming.issuedAtMs;
          log(`new lease from ${source}: ${incoming.payload.state}, valid until ${incoming.payload.valid_until}`);
        }
      }
    }
  }
  if (floorMs !== undefined) resetLicenseClock();
  await localStore.saveLicenseRecord(next, floorMs);
  return true;
}

async function setLocked(locked: boolean, why: string): Promise<boolean> {
  const rec = await localStore.getLicenseRecord();
  if (rec.locked === locked && (!locked || rec.lease === null)) return false;
  log(`${locked ? 'locked' : 'unlocked'} (${why})`);
  await localStore.saveLicenseRecord(locked ? { ...rec, locked: true, lease: null } : { ...rec, locked: false });
  return true;
}

let knownLocked: boolean | null = null; // cheap filter for the frequent 'not-locked' signal

async function handle(s: LicenseSignal): Promise<boolean> {
  switch (s.kind) {
    case 'check-in': {
      const changed = await ingestCheckIn(s.license, s.source, s.publicKeys);
      if (s.license) knownLocked = s.license.state === 'LOCKED';
      return changed;
    }
    case 'locked':
      knownLocked = true;
      return setLocked(true, s.source === 'realtime' ? 'realtime close 4402' : '403 SUBSCRIPTION_LOCKED');
    case 'not-locked':
      if (knownLocked === false) return false;
      knownLocked = false;
      return setLocked(false, 'a call refused while locked succeeded');
  }
}

let unsubscribe: (() => void) | null = null;

export const license = {
  /** Starts listening to the transport's license signals; `onChange` runs after the stored state changed. */
  start(onChange: () => void): void {
    if (unsubscribe) return;
    unsubscribe = onLicenseSignal((s) => {
      void lock
        .run(() => handle(s))
        .then((changed) => {
          if (changed) onChange();
        })
        .catch((e) => console.warn(`[license] ${e instanceof Error ? e.message : String(e)}`));
    });
  },

  stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  },
};
