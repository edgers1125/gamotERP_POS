// Paused by the administrator (403 COMPANY_INACTIVE / TERMINAL_INACTIVE / MODULE_NOT_INCLUDED, realtime close 4003) —
// the state, its stored form and the restart rule. Pure: no Expo / native imports (scripts/paused-selftest.ts loads it).
// policy.ts re-exports everything; blockReason there turns it into "Selling is paused".
export const INACTIVE_MESSAGE =
  'This till is paused by the administrator (company/terminal deactivated). Unsent sales stay on this tablet.';

export interface InactiveInfo {
  code: string;
  /** The server's own message (shown on the Check-in screen). */
  message: string;
}
export const INACTIVE_CODES: readonly string[] = ['COMPANY_INACTIVE', 'TERMINAL_INACTIVE', 'MODULE_NOT_INCLUDED'];
// Set by the sync engine on those 403s, cleared on the next successful device call (or a re-enroll). The device is NOT
// revoked and nothing is deleted. PERSISTED (user decision 2026-10-22, app 1.3.0): localStore.setInactive writes the
// meta row `inactive` and then this in-memory copy; localStore.init() reloads it, so a restart — offline too — stays
// paused until the server answers a check-in. Kept in memory as well because blockReason callers are synchronous.
let inactiveInfo: InactiveInfo | null = null;
/** The meta row's text for a paused state (null = not paused → the row is deleted). */
export function encodeInactive(info: InactiveInfo | null): string | null {
  return info ? JSON.stringify({ code: info.code, message: info.message }) : null;
}
/** The stored row back; anything unreadable but present still counts as paused (fail closed — the next check-in decides). */
export function decodeInactive(text: string | null | undefined): InactiveInfo | null {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof v?.code === 'string' && v.code ? v.code : 'TERMINAL_INACTIVE';
    return { code, message: typeof v?.message === 'string' ? v.message : INACTIVE_MESSAGE };
  } catch {
    return { code: 'TERMINAL_INACTIVE', message: INACTIVE_MESSAGE };
  }
}
export function setPlatformInactive(info: InactiveInfo | null): void {
  inactiveInfo = info;
}
export function platformInactive(): InactiveInfo | null {
  return inactiveInfo;
}

/** App start (localStore.init): a paused state saved before the restart comes back, so the till stays paused — offline
 * too — until a check-in succeeds. Never un-pauses (a state already in memory wins). */
export function loadStoredInactive(text: string | null | undefined): void {
  const stored = decodeInactive(text);
  if (stored && inactiveInfo === null) inactiveInfo = stored;
}
