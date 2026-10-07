// Attendance kiosk mode — state, cache and the punch queue (CLAUDE.md "Attendance kiosk mode"; GamotERP
// docs/plans/hr-payroll-attendance.md "Kiosk punch flow" + "Stage B — API contract" (b); pos-api/contract.ts).
//
// * Kiosk on/off: the server says so ONLY through GET /pos/attendance/kiosk (200 = on; 403 ATTENDANCE_KIOSK_OFF or
//   MODULE_NOT_INCLUDED = off) — there is no bootstrap field or real-time notice for it. `refresh()` asks: at start, after
//   every bootstrap re-read (sync engine), when the kiosk screen opens; the answer + the employee list are cached
//   (attendance_cache, per enrollment) so the kiosk works offline. No PIN data is ever cached.
// * Punches: `recordPunch` builds the payload (punch.ts), signs it with the device key (jose.signPunchPayload — the same
//   JWS as a sync op) and saves it with its photo files in ONE row of attendance_punches — online or offline, BEFORE any
//   upload, so a punch is never lost. `push()` (the sync engine's cycle + the kiosk right after a punch) uploads
//   PENDING rows oldest first, one multipart POST each, idempotent by client_uuid (a repeat answers DUPLICATE):
//   RECORDED / DUPLICATE → done, photos deleted from the tablet; 422 REJECTED → kept (photos too) for a manager;
//   network / 5xx / 401 / 429 → stays PENDING and the engine backs off; 403 ATTENDANCE_KIOSK_OFF → stays PENDING (the
//   server refuses uploads from a terminal that is no longer a kiosk — see CLAUDE.md "open issues").
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';

import type {
  AttendanceLivenessStep,
  PosAttendanceEmployee,
  PosAttendanceKiosk,
  PosAttendancePunchResult,
} from '@pos-api/contract';

import PosFace from '../../modules/pos-face';
import { appVersion, attendanceApi } from '../api/client';
import { jsonOrNull, num, rows, str, strOrNull, withDb, type Row } from '../db/database';
import { emitLocalStoreEvent } from '../db/events';
import { localStore } from '../db/localStore';
import { Mutex } from '../db/mutex';
import { jose } from '../device/jose';
import { serverClock } from '../device/serverClock';
import {
  buildPunchPayload,
  DEFAULT_CAPTURE,
  deviceChallenge,
  framesFromJson,
  framesToJson,
  punchPayloadText,
  randomIntFromBytes,
  storedPunchProblem,
  type BuildPunchInput,
  type QueuedFrame,
} from './punch';

const KIOSK_OFF_CODES = new Set(['ATTENDANCE_KIOSK_OFF', 'MODULE_NOT_INCLUDED']);
const REFRESH_MIN_INTERVAL_MS = 60_000;
const PUSH_MAX_PER_RUN = 50;
/** Frame files not listed by a waiting / rejected punch and older than this are leftovers (abandoned captures). */
const ORPHAN_FRAME_AGE_MS = 10 * 60_000;

/**
 * An ATTENDANCE_ONLY terminal (GamotERP docs/plans/attendance-pos-only.md): punches only — no cashier, catalog, display
 * or approvers; its app is Attendance | Check-in | Settings. From the enrollment / bootstrap terminal info; absent (an
 * older server or cached info) = a POS. Fixed for the terminal's life.
 */
export function isAttendanceOnlyTerminal(terminal: { terminal_type?: string } | null | undefined): boolean {
  return terminal?.terminal_type === 'ATTENDANCE_ONLY';
}

export type KioskMode = 'UNKNOWN' | 'ON' | 'OFF';

export interface AttendanceKioskState {
  /** UNKNOWN until the server (or the cache) has said. */
  mode: KioskMode;
  /** Why it is OFF (the server's message), for diagnostics. */
  offReason: string | null;
  kiosk: PosAttendanceKiosk | null;
  employees: PosAttendanceEmployee[];
  checkedAt: string | null;
  /** Punches on this tablet not yet accepted by the server. */
  unsent: number;
  /** Punches the server refused (kept for a manager). */
  rejected: number;
  /** Why the last upload stopped, or null. */
  uploadError: string | null;
}

export const useAttendanceKiosk = create<AttendanceKioskState>()(() => ({
  mode: 'UNKNOWN',
  offReason: null,
  kiosk: null,
  employees: [],
  checkedAt: null,
  unsent: 0,
  rejected: 0,
  uploadError: null,
}));
const set = (patch: Partial<AttendanceKioskState>) => useAttendanceKiosk.setState(patch);

// Duck-typed ApiError (see syncEngine.ts for why not instanceof).
interface ApiErrorLike {
  status: number;
  message: string;
  code: string | null;
}
function asApiError(e: unknown): ApiErrorLike | null {
  return e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as ApiErrorLike) : null;
}
function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

// ---- cache --------------------------------------------------------------------------------------------------------

async function currentDeviceId(): Promise<number | null> {
  return (await localStore.getEnrollment())?.device_id ?? null;
}

async function saveCache(deviceId: number, patch: { enabled: boolean; reason: string | null; kiosk: PosAttendanceKiosk | null; employees: PosAttendanceEmployee[] }): Promise<void> {
  const checkedAt = new Date().toISOString();
  await withDb((conn) =>
    conn.execute(
      `INSERT OR REPLACE INTO attendance_cache (id, device_id, enabled, reason, kiosk_json, employees_json, checked_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      [deviceId, patch.enabled ? 1 : 0, patch.reason, patch.kiosk ? JSON.stringify(patch.kiosk) : null, JSON.stringify(patch.employees), checkedAt],
    ),
  );
  set({
    mode: patch.enabled ? 'ON' : 'OFF',
    offReason: patch.enabled ? null : patch.reason,
    kiosk: patch.kiosk,
    employees: patch.employees,
    checkedAt,
  });
}

async function loadCache(): Promise<void> {
  const deviceId = await currentDeviceId();
  const row = await withDb(async (conn) => rows(await conn.execute('SELECT * FROM attendance_cache WHERE id = 1'))[0] ?? null);
  if (!row || deviceId === null || num(row.device_id) !== deviceId) {
    // Nothing known for this enrollment yet.
    set({ mode: 'UNKNOWN', offReason: null, kiosk: null, employees: [], checkedAt: null });
    return;
  }
  set({
    mode: num(row.enabled) === 1 ? 'ON' : 'OFF',
    offReason: strOrNull(row.reason),
    kiosk: jsonOrNull<PosAttendanceKiosk>(row.kiosk_json),
    employees: jsonOrNull<PosAttendanceEmployee[]>(row.employees_json) ?? [],
    checkedAt: strOrNull(row.checked_at),
  });
}

// ---- counts -------------------------------------------------------------------------------------------------------

async function refreshCounts(): Promise<void> {
  const c = await withDb(async (conn) => {
    const r = rows(
      await conn.execute(
        `SELECT SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected
           FROM attendance_punches`,
      ),
    )[0];
    return { pending: r?.pending == null ? 0 : num(r.pending), rejected: r?.rejected == null ? 0 : num(r.rejected) };
  });
  set({ unsent: c.pending, rejected: c.rejected });
}

/**
 * Unsent (PENDING) punches on this tablet, read fresh — Settings' Re-enroll warning. Re-enrolling never deletes them
 * (localStore.clearEnrollment doesn't touch attendance_punches, pruneFrames keeps their photos), but they are signed
 * with the revoked enrollment's key, which re-enrolling deletes: the server then refuses them (signature) and they stay
 * here as "Not accepted" with their photos for HR to enter by hand. A revoked device can't upload them either (401), so
 * blocking re-enroll would only strand the tablet — hence a warning, not a block.
 */
export async function unsentPunchCount(): Promise<number> {
  await refreshCounts();
  return useAttendanceKiosk.getState().unsent;
}

// ---- punches ------------------------------------------------------------------------------------------------------

export interface LocalPunch {
  clientUuid: string;
  userId: number;
  displayName: string;
  kind: 'IN' | 'OUT';
  deviceTime: string;
  online: boolean;
  status: 'PENDING' | 'RECORDED' | 'REJECTED';
  result: PosAttendancePunchResult | null;
  lastError: string | null;
  attempts: number;
}

function punchFromRow(r: Row): LocalPunch {
  return {
    clientUuid: str(r.client_uuid),
    userId: num(r.user_id),
    displayName: str(r.display_name),
    kind: str(r.kind) as 'IN' | 'OUT',
    deviceTime: str(r.device_time),
    online: num(r.online) === 1,
    status: str(r.status) as LocalPunch['status'],
    result: jsonOrNull<PosAttendancePunchResult>(r.result_json),
    lastError: strOrNull(r.last_error),
    attempts: num(r.attempts),
  };
}

/** A captured frame, as the liveness step hands it over. */
export type CapturedPunchFrame = QueuedFrame;

export interface RecordPunchInput {
  employee: { user_id: number; display_name: string };
  kind: 'IN' | 'OUT';
  /** From POST /pos/attendance/pin (online); null = offline punch. */
  ticket: { ticket: string; steps: AttendanceLivenessStep[] } | null;
  /** The device challenge that was run offline (ignored with a ticket). */
  deviceSteps: AttendanceLivenessStep[];
  liveness: BuildPunchInput['liveness'];
  frames: CapturedPunchFrame[];
}

const recordLock = new Mutex();

/** A random 2-step device challenge for an offline punch (crypto randomness). */
export function newDeviceChallenge(): AttendanceLivenessStep[] {
  const bytes = Crypto.getRandomBytes(32);
  let i = 0;
  return deviceChallenge((n) =>
    randomIntFromBytes(n, () => {
      if (i >= bytes.length) throw new Error('Out of random bytes');
      return bytes[i++]!;
    }),
  );
}

/**
 * Signs and saves a punch (with its photo files) on this tablet — the punch exists from here on, whatever happens to
 * the upload. Returns the saved punch (PENDING). Also flips the cached suggestion for that employee (IN → OUT).
 */
export function recordPunch(input: RecordPunchInput): Promise<LocalPunch> {
  return recordLock.run(async () => {
    const enrollment = await localStore.getEnrollment();
    if (!enrollment) throw new Error('This device is not enrolled.');
    const capture = useAttendanceKiosk.getState().kiosk?.capture ?? DEFAULT_CAPTURE;
    const clientUuid = Crypto.randomUUID().toLowerCase();
    const deviceTime = new Date(await serverClock.nowMs());
    const payload = buildPunchPayload(
      {
        clientUuid,
        userId: input.employee.user_id,
        kind: input.kind,
        deviceTime,
        ticket: input.ticket,
        deviceSteps: input.deviceSteps,
        liveness: input.liveness,
        frames: input.frames.map((f) => ({ index: f.index, step: f.step, sha256: f.sha256 })),
        appVersion: appVersion(),
      },
      capture,
    );
    const text = punchPayloadText(payload);
    const signature = await jose.signPunchPayload(payload);
    const createdAt = new Date().toISOString();
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO attendance_punches (client_uuid, device_id, user_id, display_name, kind, device_time, online, payload_json,
                                           signature, frames_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
          [
            clientUuid,
            enrollment.device_id,
            input.employee.user_id,
            input.employee.display_name,
            input.kind,
            payload.device_time,
            input.ticket ? 1 : 0,
            text,
            signature,
            framesToJson(input.frames),
            createdAt,
          ],
        );
      }),
    );
    await flipSuggestion(input.employee.user_id, input.kind).catch(() => undefined);
    await refreshCounts();
    emitLocalStoreEvent('enqueued'); // the sync engine runs a cycle now (it pushes punches too)
    return {
      clientUuid,
      userId: input.employee.user_id,
      displayName: input.employee.display_name,
      kind: input.kind,
      deviceTime: payload.device_time,
      online: !!input.ticket,
      status: 'PENDING',
      result: null,
      lastError: null,
      attempts: 0,
    };
  });
}

/** After a punch: suggest the other kind for that person until the server's list says otherwise. */
async function flipSuggestion(userId: number, kind: 'IN' | 'OUT'): Promise<void> {
  const s = useAttendanceKiosk.getState();
  const deviceId = await currentDeviceId();
  if (deviceId === null || s.mode !== 'ON') return;
  const employees = s.employees.map((e) => (e.user_id === userId ? { ...e, suggested_kind: kind === 'IN' ? ('OUT' as const) : ('IN' as const) } : e));
  await saveCache(deviceId, { enabled: true, reason: null, kiosk: s.kiosk, employees });
}

export async function getPunch(clientUuid: string): Promise<LocalPunch | null> {
  const r = await withDb(async (conn) => rows(await conn.execute('SELECT * FROM attendance_punches WHERE client_uuid = ?', [clientUuid]))[0]);
  return r ? punchFromRow(r) : null;
}

/** Punches the server refused (newest first) — shown on the kiosk for a manager. */
export async function rejectedPunches(limit = 50): Promise<LocalPunch[]> {
  return withDb(async (conn) =>
    rows(await conn.execute(`SELECT * FROM attendance_punches WHERE status = 'REJECTED' ORDER BY seq DESC LIMIT ?`, [limit])).map(punchFromRow),
  );
}

async function markAttempt(seq: number, error: string): Promise<void> {
  await withDb((conn) =>
    conn.execute('UPDATE attendance_punches SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE seq = ?', [
      error.slice(0, 500),
      new Date().toISOString(),
      seq,
    ]),
  );
}

/** Kept, visibly, as REJECTED — something the server can never accept as signed (never retried unchanged). */
async function markRejected(seq: number, clientUuid: string, error: string): Promise<void> {
  const result: PosAttendancePunchResult = {
    client_uuid: clientUuid,
    status: 'REJECTED',
    punch_id: null,
    occurred_at: null,
    flags: [],
    employees_version: '',
    error,
  };
  const now = new Date().toISOString();
  await withDb((conn) =>
    conn.execute(
      `UPDATE attendance_punches SET status = 'REJECTED', result_json = ?, last_error = ?, attempts = attempts + 1, last_attempt_at = ?, done_at = ?
        WHERE seq = ? AND status = 'PENDING'`,
      [JSON.stringify(result), error.slice(0, 500), now, now, seq],
    ),
  );
}

async function applyResult(seq: number, frames: QueuedFrame[], res: PosAttendancePunchResult): Promise<void> {
  const now = new Date().toISOString();
  const accepted = res.status === 'RECORDED' || res.status === 'DUPLICATE';
  await withDb((conn) =>
    conn.execute(
      `UPDATE attendance_punches SET status = ?, result_json = ?, last_error = ?, attempts = attempts + 1, last_attempt_at = ?, done_at = ?
        WHERE seq = ?`,
      [accepted ? 'RECORDED' : 'REJECTED', JSON.stringify(res), accepted ? null : (res.error ?? 'Refused by the server').slice(0, 500), now, now, seq],
    ),
  );
  if (accepted && frames.length > 0 && PosFace) {
    // The server has the photos: they leave the tablet now (a failure here is retried by pruneFrames).
    try {
      await PosFace.deleteFrames(frames.map((f) => f.path));
      await withDb((conn) => conn.execute('UPDATE attendance_punches SET frames_deleted_at = ? WHERE seq = ?', [new Date().toISOString(), seq]));
    } catch {
      // pruneFrames will remove them
    }
  } else if (accepted) {
    await withDb((conn) => conn.execute('UPDATE attendance_punches SET frames_deleted_at = ? WHERE seq = ?', [now, seq]));
  }
}

let pushing: Promise<boolean> | null = null;
/** After a 403 ATTENDANCE_KIOSK_OFF on upload: don't re-send the photos every cycle — retry after this (or once the
 * kiosk answers ON again). */
let kioskOffRetryAt = 0;
const KIOSK_OFF_RETRY_MS = 15 * 60_000;

/**
 * Uploads waiting punches, oldest first. Returns true when the server was contacted. Throws on a network / server
 * failure (the punch stays PENDING; the sync engine backs off) — never drops or reorders a punch.
 */
export function pushPunches(): Promise<boolean> {
  if (Date.now() < kioskOffRetryAt) return Promise.resolve(false);
  if (!pushing) {
    pushing = pushInner().finally(() => {
      pushing = null;
    });
  }
  return pushing;
}

async function pushInner(): Promise<boolean> {
  let contacted = false;
  let employeesChanged = false;
  try {
    for (let n = 0; n < PUSH_MAX_PER_RUN; n++) {
      const row = await withDb(async (conn) => rows(await conn.execute(`SELECT * FROM attendance_punches WHERE status = 'PENDING' ORDER BY seq LIMIT 1`))[0]);
      if (!row) {
        set({ uploadError: null });
        break;
      }
      const seq = num(row.seq);
      const clientUuid = str(row.client_uuid);
      const text = str(row.payload_json);
      let frames: QueuedFrame[];
      try {
        frames = framesFromJson(str(row.frames_json));
      } catch {
        await markRejected(seq, clientUuid, "This punch's photo list is unreadable on the tablet");
        continue;
      }
      const problem = storedPunchProblem(text, frames);
      if (problem) {
        await markRejected(seq, clientUuid, `Not sent — ${problem}`);
        continue;
      }
      if (frames.length > 0 && PosFace) {
        let missing = false;
        for (const f of frames) if (!(await PosFace.frameExists(f.path))) missing = true;
        if (missing) {
          // The signature covers the photos: without them the punch can't be sent as signed.
          await markRejected(seq, clientUuid, 'A photo of this punch is missing on the tablet — it could not be sent');
          continue;
        }
      }
      let res: PosAttendancePunchResult;
      try {
        res = await attendanceApi.punch({
          punchText: text,
          signature: str(row.signature),
          files: frames
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((f) => ({ name: `frame${f.index}`, uri: f.uri, filename: `frame${f.index}.jpg` })),
        });
      } catch (e) {
        const err = asApiError(e);
        if (!err || err.status === 0) {
          await markAttempt(seq, messageOf(e));
          throw e;
        }
        contacted = true;
        if (err.status === 403 && err.code && KIOSK_OFF_CODES.has(err.code)) {
          // The server no longer takes punches from this terminal: they wait (never dropped) until it is a kiosk again.
          await markAttempt(seq, err.message);
          set({ uploadError: `Punches can't be sent: ${err.message}` });
          kioskOffRetryAt = Date.now() + KIOSK_OFF_RETRY_MS;
          return contacted;
        }
        if (err.status === 409 && err.code === 'DUPLICATE') {
          // Recorded by a parallel upload a moment ago — the next try answers DUPLICATE with the stored result.
          await markAttempt(seq, err.message);
          continue;
        }
        if (err.status === 400 || err.status === 409 || err.status === 413 || err.status === 415) {
          await markRejected(seq, clientUuid, `Refused by the server: ${err.message}`);
          continue;
        }
        await markAttempt(seq, err.message);
        set({ uploadError: `Punches not sent yet: ${err.message}` });
        throw e;
      }
      contacted = true;
      await applyResult(seq, frames, res);
      const cachedVersion = useAttendanceKiosk.getState().kiosk?.employees_version;
      if (res.employees_version && cachedVersion && res.employees_version !== cachedVersion) employeesChanged = true;
    }
  } finally {
    await refreshCounts().catch(() => undefined);
    await pruneFrames().catch(() => undefined);
  }
  if (employeesChanged) void refreshKiosk({ force: true });
  return contacted;
}

/**
 * Uploads now and waits (up to `timeoutMs`) for THIS punch's answer — the kiosk's confirmation screen. The punch is
 * already saved; a timeout / failure only means "sent later".
 */
export async function uploadAndWait(clientUuid: string, timeoutMs: number): Promise<LocalPunch | null> {
  const deadline = Date.now() + timeoutMs;
  // A push already running may have read the queue before this punch was saved: then one more run picks it up.
  for (let i = 0; i < 2; i++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let failed = false;
    const run = pushPunches().catch(() => {
      failed = true;
    });
    await Promise.race([run, new Promise<void>((resolve) => setTimeout(resolve, left))]);
    const p = await getPunch(clientUuid);
    if (!p || p.status !== 'PENDING' || failed) return p;
  }
  return getPunch(clientUuid);
}

/** Deletes photo files nobody needs any more: not listed by a waiting / rejected punch, older than a few minutes. */
export async function pruneFrames(): Promise<void> {
  if (!PosFace) return;
  const files = await PosFace.listFrames();
  if (files.length === 0) return;
  const keep = new Set<string>();
  await withDb(async (conn) => {
    for (const r of rows(await conn.execute(`SELECT frames_json FROM attendance_punches WHERE status IN ('PENDING', 'REJECTED')`))) {
      try {
        for (const f of framesFromJson(str(r.frames_json))) keep.add(f.path);
      } catch {
        // unreadable row: keep everything rather than guess
        files.forEach((x) => keep.add(x.path));
      }
    }
  });
  const now = Date.now();
  const stale = files.filter((f) => !keep.has(f.path) && now - f.modifiedAt > ORPHAN_FRAME_AGE_MS).map((f) => f.path);
  if (stale.length) await PosFace.deleteFrames(stale);
  await withDb((conn) =>
    conn.execute(`UPDATE attendance_punches SET frames_deleted_at = ? WHERE status = 'RECORDED' AND frames_deleted_at IS NULL`, [new Date().toISOString()]),
  );
}

/** Deletes the files of an abandoned capture (the person cancelled before the punch was saved). */
export async function discardFrames(frames: { path: string }[]): Promise<void> {
  if (!PosFace || frames.length === 0) return;
  await PosFace.deleteFrames(frames.map((f) => f.path)).catch(() => undefined);
}

// ---- kiosk on/off + employees ------------------------------------------------------------------------------------

let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;

/**
 * Asks the server whether this terminal is an attendance kiosk (and refreshes the employee list). Never throws: offline
 * / server errors keep the cached state. `force` skips the 60-s throttle.
 */
export function refreshKiosk(opts?: { force?: boolean }): Promise<void> {
  if (refreshing) return refreshing;
  if (!opts?.force && Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  refreshing = (async () => {
    lastRefreshAt = Date.now();
    const deviceId = await currentDeviceId();
    if (deviceId === null) return;
    try {
      const kiosk = await attendanceApi.kiosk();
      const list = await attendanceApi.employees();
      await saveCache(deviceId, { enabled: true, reason: null, kiosk: { ...kiosk, employees_version: list.version }, employees: list.items });
      kioskOffRetryAt = 0; // a kiosk again: waiting punches go out on the next cycle
    } catch (e) {
      const err = asApiError(e);
      if (err && err.status === 403 && err.code && KIOSK_OFF_CODES.has(err.code)) {
        await saveCache(deviceId, { enabled: false, reason: err.message, kiosk: null, employees: [] });
      }
      // anything else (offline, 5xx, a locked subscription): keep what is cached
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Loads the cache + counts (app start, after enrollment). Never throws. */
export async function loadKiosk(): Promise<void> {
  await loadCache().catch(() => undefined);
  await refreshCounts().catch(() => undefined);
}

