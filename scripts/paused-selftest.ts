// Self-test of the "paused by the administrator" state surviving an app restart (src/db/inactive.ts; user decision
// 2026-10-22, app 1.3.0) — no device, no database, no server. The meta table is a Map here; the steps are the ones
// localStore.setInactive (write row, then memory), localStore.init (loadStoredInactive) and the sync engine
// (markInactive on 403 COMPANY_INACTIVE / TERMINAL_INACTIVE / MODULE_NOT_INCLUDED, clearInactive after a check-in that
// reached the server) take.
//
// Run from the app root:
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/paused-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import {
  decodeInactive,
  encodeInactive,
  INACTIVE_CODES,
  INACTIVE_MESSAGE,
  loadStoredInactive,
  platformInactive,
  setPlatformInactive,
  type InactiveInfo,
} from '../src/db/inactive';

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

// ---- a fake meta table + the app's steps ----------------------------------------------------------------------------
const meta = new Map<string, string>();
const KEY = 'inactive';
/** localStore.setInactive */
function setInactive(info: InactiveInfo | null): void {
  const text = encodeInactive(info);
  if (info) setPlatformInactive(info);
  if (text === null) meta.delete(KEY);
  else meta.set(KEY, text);
  if (!info) setPlatformInactive(null);
}
/** An app restart: memory gone, localStore.init reloads the row. */
function restart(): void {
  setPlatformInactive(null);
  loadStoredInactive(meta.get(KEY) ?? null);
}
/** What blockReason says about it (policy.ts: `if (input.inactive) return INACTIVE_MESSAGE`). */
const sellingBlocked = () => (platformInactive() !== null ? INACTIVE_MESSAGE : null);

// ---- stored form -----------------------------------------------------------------------------------------------------
check('not paused → no row', encodeInactive(null) === null);
const info = { code: 'TERMINAL_INACTIVE', message: 'This terminal was deactivated' };
check('round trip', JSON.stringify(decodeInactive(encodeInactive(info))) === JSON.stringify(info));
check('no row → not paused', decodeInactive(null) === null && decodeInactive(undefined) === null);
check('unreadable row → still paused (fail closed)', decodeInactive('{not json')?.code === 'TERMINAL_INACTIVE');
check('row without a message → the standard message', decodeInactive('{"code":"COMPANY_INACTIVE"}')?.message === INACTIVE_MESSAGE);
check('the three codes pause', ['COMPANY_INACTIVE', 'TERMINAL_INACTIVE', 'MODULE_NOT_INCLUDED'].every((c) => INACTIVE_CODES.includes(c)));
check('a revoked / locked code is not "paused"', !INACTIVE_CODES.includes('DEVICE_REVOKED') && !INACTIVE_CODES.includes('SUBSCRIPTION_LOCKED'));

// ---- the scenario: pause → force-close → reopen offline → still paused → reactivated → check-in → selling --------------
check('fresh start: selling allowed', sellingBlocked() === null);
setInactive({ code: 'COMPANY_INACTIVE', message: 'Company deactivated' }); // 403 at a check-in
check('paused: selling blocked', sellingBlocked() === INACTIVE_MESSAGE);
restart(); // force-close + reopen, offline (no check-in happens)
check('after restart (offline): still paused', sellingBlocked() === INACTIVE_MESSAGE && platformInactive()?.code === 'COMPANY_INACTIVE');
restart();
check('after a second restart: still paused', sellingBlocked() === INACTIVE_MESSAGE);
setInactive(null); // reactivated on the web → the next check-in reaches the server → clearInactive
check('check-in succeeded: selling allowed', sellingBlocked() === null && !meta.has(KEY));
restart();
check('restart after reactivation: still allowed', sellingBlocked() === null);

// A restart never un-pauses a state already in memory (init runs every sync cycle).
setInactive({ code: 'TERMINAL_INACTIVE', message: 'x' });
meta.delete(KEY); // e.g. read before the write landed
loadStoredInactive(null);
check('loading "no row" does not clear memory', platformInactive() !== null);
setInactive(null);

// Re-enroll (localStore.clearEnrollment): row deleted + memory cleared → the new enrollment starts unpaused.
setInactive({ code: 'TERMINAL_INACTIVE', message: 'x' });
meta.delete(KEY);
setPlatformInactive(null);
restart();
check('re-enroll: not paused', sellingBlocked() === null);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
