import { BUSINESS_TIME_ZONE } from '@shared/business-day';

import { ApiError } from '../../contracts';

const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "02:15 PM" (Manila) — empty for a missing/invalid instant. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

/** "Sep 25, 2026, 02:15 PM" (Manila) — "—" for a missing instant. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

/** Shifts a YYYY-MM-DD calendar date by whole days (pure calendar arithmetic, no time zone involved). */
export function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "5 min ago" style age of an instant. */
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** User-facing text for an error: the first field error of a 400, a plain "no connection" for a network failure. */
export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  if (e instanceof ApiError) {
    if (e.isNetwork) return 'No connection to the server.';
    const first = e.fieldErrors ? Object.values(e.fieldErrors).find((v) => v && v.length > 0)?.[0] : undefined;
    return first ?? (e.message || fallback);
  }
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const msg = (e as { message: string }).message;
    return msg || fallback;
  }
  return fallback;
}
