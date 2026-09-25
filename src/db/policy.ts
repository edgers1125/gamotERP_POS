// Selling-block policy shared by the sync engine (SyncStatus.blockedReason, shown by the UI) and localStore.recordSale
// (which refuses on the same rules, so a sale can never slip past a stale UI). Pure functions + the app version.
import type { PosTerminalInfo } from '@pos-api/contract';

import { appVersionName } from '../config/runtime';

/** This build's version (app.json "version" → versionName), as sent in heartbeats. */
export const APP_VERSION: string = appVersionName();

/** Compares dotted numeric versions ("1.2.10" > "1.2.9"); missing parts count as 0, non-numeric parts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface BlockInputs {
  revoked: boolean;
  updateRequired: string | null;
  terminal: Pick<PosTerminalInfo, 'offline_max_hours' | 'offline_max_sales'> | null;
  pendingOldestAt: string | null;
  pendingSales: number;
  now?: Date;
}

export const REVOKED_MESSAGE =
  'This device has been revoked. Selling is disabled — ask your administrator to enroll a new device.';

/** Stored/returned as `updateRequired` when the server refused the app (426) without saying which version it needs. */
export const UNKNOWN_MIN_VERSION = 'newer';

export function updateRequiredMessage(minVersion: string): string {
  const need = /^\d/.test(minVersion) ? `version ${minVersion} or newer is required` : 'a newer version is required';
  return `This app version (${APP_VERSION}) is too old — ${need}. Update the app to continue selling.`;
}

/** The terminal's offline limits: the device stops selling once either is reached (the server also flags it). */
export function offlineLimitReason(input: BlockInputs): string | null {
  const t = input.terminal;
  if (!t) return null;
  const now = input.now ?? new Date();
  if (input.pendingOldestAt) {
    const hours = (now.getTime() - new Date(input.pendingOldestAt).getTime()) / 3_600_000;
    if (Number.isFinite(hours) && hours >= t.offline_max_hours) {
      return (
        `Sales have not reached the server for more than ${t.offline_max_hours} hour(s) ` +
        `(oldest unsynced since ${new Date(input.pendingOldestAt).toLocaleString()}). ` +
        'Connect to the network and let the device sync before selling again.'
      );
    }
  }
  if (input.pendingSales >= t.offline_max_sales) {
    return (
      `${input.pendingSales} sale(s) are waiting to sync — the offline limit for this terminal is ${t.offline_max_sales}. ` +
      'Connect to the network and let the device sync before selling again.'
    );
  }
  return null;
}

/** Why selling is blocked right now, or null. Order: revoked, app update, offline limits. */
export function blockReason(input: BlockInputs): string | null {
  if (input.revoked) return REVOKED_MESSAGE;
  if (input.updateRequired) return updateRequiredMessage(input.updateRequired);
  return offlineLimitReason(input);
}
