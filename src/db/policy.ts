// Selling-block policy shared by the sync engine (SyncStatus.blockedReason, shown by the UI) and localStore.recordSale
// (which refuses on the same rules, so a sale can never slip past a stale UI). Pure functions + the app version.
//
// What is blocked is SELLING only (recordSale). Check-in (heartbeat / device token / bootstrap / upload of unsent
// sales), voids of today's sales, X/Z readings, reprints, journal export and settings never go through blockReason.
import type { PosTerminalInfo } from '@pos-api/contract';

import { BUSINESS_TIME_ZONE } from '@shared/business-day';

import { appVersionName } from '../config/runtime';
import type { LicenseCode } from '../license/lease';

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

type TerminalLimits = Pick<PosTerminalInfo, 'offline_max_hours' | 'offline_max_sales'> &
  Partial<Pick<PosTerminalInfo, 'offline_unlimited' | 'offline_warn_hours'>>;

export interface BlockInputs {
  revoked: boolean;
  updateRequired: string | null;
  terminal: TerminalLimits | null;
  pendingOldestAt: string | null;
  pendingSales: number;
  /** The license lease judged now (src/license/licenseEval.ts); null/absent = not checked. */
  license?: LicenseCode | null;
  now?: Date;
}

export const REVOKED_MESSAGE =
  'This device has been revoked. Selling is disabled — ask your administrator to enroll a new device.';

// ---- license lease (contract "License lease"; plan pos-license-and-billing-lock.md Part C) --------------------------
export const LICENSE_EXPIRED_MESSAGE = 'License expired — connect to the internet to check in.';
export const SUBSCRIPTION_LOCKED_MESSAGE = 'Subscription locked — contact your administrator.';

/** Blocks selling for LOCKED / EXPIRED; never for NOT_ENFORCED (no lease ever received) or NO_KEYS. */
export function licenseBlockReason(code: LicenseCode | null | undefined): string | null {
  if (code === 'LOCKED') return SUBSCRIPTION_LOCKED_MESSAGE;
  if (code === 'EXPIRED') return LICENSE_EXPIRED_MESSAGE;
  return null;
}

const dateFmt = new Intl.DateTimeFormat('en-PH', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** The non-blocking license banner: OVERDUE → when selling stops; within 7 days of valid_until → check in before. */
export function licenseWarningMessage(warn: 'OVERDUE' | 'EXPIRING' | null, validUntilMs: number | null): string | null {
  if (!warn || validUntilMs === null) return null;
  // valid_until is exclusive; for OVERDUE it is Manila midnight starting the lock day, so its Manila date IS that day.
  if (warn === 'OVERDUE') return `Payment overdue — selling stops on ${dateFmt.format(new Date(validUntilMs))}.`;
  return `Check in before ${dateTimeFmt.format(new Date(validUntilMs))} or selling stops.`;
}

/** Stored/returned as `updateRequired` when the server refused the app (426) without saying which version it needs. */
export const UNKNOWN_MIN_VERSION = 'newer';

export function updateRequiredMessage(minVersion: string): string {
  const need = /^\d/.test(minVersion) ? `version ${minVersion} or newer is required` : 'a newer version is required';
  return `This app version (${APP_VERSION}) is too old — ${need}. Update the app to continue selling.`;
}

/** The terminal's offline limits: the device stops selling once either is reached (the server also flags it). A
 * terminal with "No offline limit" (`offline_unlimited`, docs/plans/pos-offline-unlimited.md) never blocks for them. */
export function offlineLimitReason(input: BlockInputs): string | null {
  const t = input.terminal;
  if (!t || t.offline_unlimited === true) return null;
  const now = input.now ?? new Date();
  if (input.pendingOldestAt) {
    const hours = (now.getTime() - new Date(input.pendingOldestAt).getTime()) / 3_600_000;
    if (Number.isFinite(hours) && hours >= t.offline_max_hours) {
      return (
        `Sales have not reached the server for more than ${t.offline_max_hours} hour(s) ` +
        `(oldest unsent since ${dateTimeFmt.format(new Date(input.pendingOldestAt))}). ` +
        'Connect to the internet and let the device check in before selling again.'
      );
    }
  }
  if (input.pendingSales >= t.offline_max_sales) {
    return (
      `${input.pendingSales} unsent sale(s) — the offline limit for this terminal is ${t.offline_max_sales}. ` +
      'Connect to the internet and let the device check in before selling again.'
    );
  }
  return null;
}

/** Default `offline_warn_hours` when the cached terminal info predates it. */
export const DEFAULT_OFFLINE_WARN_HOURS = 24;

/**
 * The non-blocking "not checked in" banner (pos-offline-unlimited.md app spec A3): the oldest unsent op is older than
 * the terminal's `offline_warn_hours`, OR the last successful server contact is. Every terminal, limits or not.
 */
export function offlineWarning(input: {
  terminal: TerminalLimits | null;
  pendingOldestAt: string | null;
  pendingSales: number;
  lastCheckInAt: string | null;
  now?: Date;
}): string | null {
  const t = input.terminal;
  if (!t) return null;
  const warnHours = typeof t.offline_warn_hours === 'number' && t.offline_warn_hours > 0 ? t.offline_warn_hours : DEFAULT_OFFLINE_WARN_HOURS;
  const now = (input.now ?? new Date()).getTime();
  const hoursSince = (iso: string | null) => {
    if (!iso) return null;
    const h = (now - new Date(iso).getTime()) / 3_600_000;
    return Number.isFinite(h) ? h : null;
  };
  const sinceContact = hoursSince(input.lastCheckInAt);
  const sincePending = hoursSince(input.pendingOldestAt);
  const sales = input.pendingSales > 0 ? ` — ${input.pendingSales} unsent sale(s) only on this tablet` : '';
  if (sinceContact !== null && sinceContact >= warnHours) {
    return `Not checked in for ${Math.floor(sinceContact)} h${sales}. Connect to the internet.`;
  }
  if (sincePending !== null && sincePending >= warnHours) {
    return `Unsent for ${Math.floor(sincePending)} h${sales}. Connect to the internet and let the device check in.`;
  }
  return null;
}

// ---- attendance (GamotERP docs/plans/attendance-pos-only.md) --------------------------------------------------------
export const ATTENDANCE_REVOKED_MESSAGE = 'This device has been revoked — attendance punches are off. Ask your administrator to enroll a new device.';
export const ATTENDANCE_LOCKED_MESSAGE = 'Subscription locked — attendance punches are off. Contact your administrator.';
export const ATTENDANCE_LICENSE_EXPIRED_MESSAGE = 'License expired — connect to the internet to check in, then punch again.';

/**
 * Why NEW attendance punches are blocked right now, or null. Same lock rule as selling (the server stops the kiosk at
 * LOCKED, works through OVERDUE): revoked, app update, LOCKED, expired lease. Never the offline sale limits — punches
 * aren't sales. Punches already saved on the tablet still upload (the server records them).
 */
export function attendanceBlockReason(input: Pick<BlockInputs, 'revoked' | 'updateRequired' | 'license'>): string | null {
  if (input.revoked) return ATTENDANCE_REVOKED_MESSAGE;
  if (input.updateRequired) {
    const need = /^\d/.test(input.updateRequired) ? `version ${input.updateRequired} or newer is required` : 'a newer version is required';
    return `This app version (${APP_VERSION}) is too old — ${need}. Update the app to take attendance again.`;
  }
  if (input.license === 'LOCKED') return ATTENDANCE_LOCKED_MESSAGE;
  if (input.license === 'EXPIRED') return ATTENDANCE_LICENSE_EXPIRED_MESSAGE;
  return null;
}

/** Why selling is blocked right now, or null. Order: revoked, app update, subscription locked / license, offline limits. */
export function blockReason(input: BlockInputs): string | null {
  if (input.revoked) return REVOKED_MESSAGE;
  if (input.updateRequired) return updateRequiredMessage(input.updateRequired);
  return licenseBlockReason(input.license) ?? offlineLimitReason(input);
}
