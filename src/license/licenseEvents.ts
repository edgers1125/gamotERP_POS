// License signals from the transport (api/client.ts, sync/realtime.ts) to whoever stores them (src/license/license.ts,
// wired by the sync engine). No imports, so the API client can emit without an import cycle.
import type { PosLicense, PosLicensePublicKey } from '@pos-api/contract';

export type LicenseSignal =
  /** A check-in response (device token / heartbeat / bootstrap). `license` undefined = the server sent none. */
  | { kind: 'check-in'; source: 'token' | 'heartbeat' | 'bootstrap'; license: PosLicense | undefined; publicKeys?: PosLicensePublicKey[] }
  /** 403 SUBSCRIPTION_LOCKED on a REST call, or realtime close 4402. */
  | { kind: 'locked'; source: 'rest' | 'realtime' }
  /** A call that a LOCKED company is refused (catalog, display, session…) succeeded: the server isn't locked now. */
  | { kind: 'not-locked' };

const listeners = new Set<(s: LicenseSignal) => void>();

export function onLicenseSignal(listener: (s: LicenseSignal) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLicenseSignal(s: LicenseSignal): void {
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      // a listener's failure never affects the request
    }
  }
}
