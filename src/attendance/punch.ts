// Building, checking and (de)serialising an attendance punch for the offline queue — pure code (no React / native /
// database), shared by the queue (punchQueue.ts) and the self-test (scripts/attendance-selftest.ts).
//
// What goes over the wire (pos-api/contract.ts "Attendance kiosk mode"): multipart field `punch` = the payload JSON,
// `signature` = compact JWS over canonicalJson(payload), files frame0..frameN-1. The server verifies the JWS against
// canonicalJson(JSON.parse(punch)), so the app stores and sends EXACTLY canonicalJson(payload) — the text that was
// signed — and never re-serialises it. Each frame's sha256 (hex of the file's bytes) is inside the payload, so the
// signature covers the photos too; the files are uploaded unchanged from disk.
import {
  canonicalJson,
  type AttendanceFrameStep,
  type AttendanceLivenessStep,
  type PosAttendanceCapture,
  type PosAttendanceEmployee,
  type PosAttendancePunchPayload,
  type PosPunchKind,
  type PosPunchState,
} from '@pos-api/contract';

export const LIVENESS_STEPS: readonly AttendanceLivenessStep[] = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT'];
const FRAME_STEPS: readonly AttendanceFrameStep[] = ['START', ...LIVENESS_STEPS];

// ---- punch kinds (GamotERP lib/attendance/countable.ts — THE rule; that file imports Prisma, so the few lines the
// kiosk needs are mirrored here) ---------------------------------------------------------------------------------------
//   IN / OUT = start / end of work; BREAK_OUT / BREAK_IN = the lunch break (everyone, not counted);
//   TRANSPORT_OUT / TRANSPORT_IN = travelling between two of the employee's branches (multi-branch only, counted).
export const PUNCH_KINDS: readonly PosPunchKind[] = ['IN', 'OUT', 'BREAK_OUT', 'BREAK_IN', 'TRANSPORT_OUT', 'TRANSPORT_IN'];
export const isPunchKind = (k: unknown): k is PosPunchKind => typeof k === 'string' && (PUNCH_KINDS as readonly string[]).includes(k);
export const isTransportKind = (k: PosPunchKind): boolean => k === 'TRANSPORT_OUT' || k === 'TRANSPORT_IN';
/** After this punch the person is still on the clock (time in, back from the break, a transport punch). */
export const onTheClockAfter = (k: PosPunchKind): boolean => k === 'IN' || k === 'BREAK_IN' || isTransportKind(k);

export const PUNCH_KIND_LABEL: Record<PosPunchKind, string> = {
  IN: 'Time in',
  OUT: 'Time out',
  BREAK_OUT: 'Start break',
  BREAK_IN: 'End break',
  TRANSPORT_OUT: 'Transport Start',
  TRANSPORT_IN: 'Transport End',
};

type KindInfo = Pick<PosAttendanceEmployee, 'suggested_kind' | 'last_kind' | 'multi_branch'>;

/** The kinds this person may punch: break for everyone, transport only when stationed at 2+ branches (web kiosk too). */
export function punchKindsFor(e: KindInfo): PosPunchKind[] {
  return e.multi_branch === true ? [...PUNCH_KINDS] : PUNCH_KINDS.filter((k) => !isTransportKind(k));
}

/** What the kiosk suggests: back from the break after a break start, arrived after a transport start, else the server's IN / OUT. */
export function suggestedKindOf(e: KindInfo): PosPunchKind {
  if (e.last_kind === 'BREAK_OUT') return 'BREAK_IN';
  if (e.last_kind === 'TRANSPORT_OUT' && e.multi_branch === true) return 'TRANSPORT_IN';
  return e.suggested_kind === 'OUT' ? 'OUT' : 'IN';
}

// ---- punch ORDER (GamotERP lib/attendance/punch-order.ts — THE rule; mirrored here, one table) --------------------------
//   OFF (none / OUT / last punch older than the open-shift limit) → IN only
//   WORKING (IN, BREAK_IN, TRANSPORT_IN) → BREAK_OUT, TRANSPORT_OUT (multi-branch only), OUT
//   ON_BREAK (BREAK_OUT) → BREAK_IN only;  IN_TRANSPORT (TRANSPORT_OUT) → TRANSPORT_IN only (multi-branch).
// The server never refuses an UPLOAD for the order (it flags it), so a punch taken offline is always uploaded.

/** The server's `open_shift_limit_hours` (16) until a list says otherwise. */
export const DEFAULT_OPEN_SHIFT_LIMIT_HOURS = 16;

export type PunchOrderState = PosPunchState['state'];

const toMs = (t: Date | string | number): number => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

/** Where the person stands after `lastKind` at `lastAt`, judged at `now`. A shift open longer than the limit counts as closed (OFF). */
export function punchOrderStateAfter(
  lastKind: PosPunchKind | null | undefined,
  lastAt: Date | string | null | undefined,
  now: Date | string | number,
  multiBranch: boolean,
  openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS,
): { state: PunchOrderState; missingTimeOut: boolean } {
  if (!lastKind || lastAt === null || lastAt === undefined) return { state: 'OFF', missingTimeOut: false };
  const open: PunchOrderState =
    lastKind === 'BREAK_OUT' ? 'ON_BREAK' : lastKind === 'TRANSPORT_OUT' ? (multiBranch ? 'IN_TRANSPORT' : 'WORKING') : lastKind === 'OUT' ? 'OFF' : 'WORKING';
  if (open === 'OFF') return { state: 'OFF', missingTimeOut: false };
  const at = toMs(lastAt);
  if (!Number.isNaN(at) && toMs(now) - at > openShiftLimitHours * 3_600_000) return { state: 'OFF', missingTimeOut: true };
  return { state: open, missingTimeOut: false };
}

/** The kinds that may be punched next (OUT first = the big button). Transport only for a multi-branch employee. */
export function allowedKindsOf(state: PunchOrderState, multiBranch: boolean): PosPunchKind[] {
  switch (state) {
    case 'OFF':
      return ['IN'];
    case 'WORKING':
      return multiBranch ? ['OUT', 'BREAK_OUT', 'TRANSPORT_OUT'] : ['OUT', 'BREAK_OUT'];
    case 'ON_BREAK':
      return ['BREAK_IN'];
    case 'IN_TRANSPORT':
      return ['TRANSPORT_IN'];
  }
}

/** THE local rule: what may come after `lastKind` (at `lastAt`) when it is `now`. */
export function allowedKindsAfter(
  lastKind: PosPunchKind | null | undefined,
  lastAt: Date | string | null | undefined,
  now: Date | string | number,
  multiBranch: boolean,
  openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS,
): PosPunchKind[] {
  return allowedKindsOf(punchOrderStateAfter(lastKind, lastAt, now, multiBranch, openShiftLimitHours).state, multiBranch);
}

/** A whole PosPunchState from the last punch (what the cache keeps for an employee after a punch on this tablet). */
export function punchStateAfter(
  lastKind: PosPunchKind | null,
  lastAt: Date | string | null,
  now: Date | string | number,
  multiBranch: boolean,
  openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS,
): PosPunchState {
  const { state, missingTimeOut } = punchOrderStateAfter(lastKind, lastAt, now, multiBranch, openShiftLimitHours);
  return {
    state,
    allowed_kinds: allowedKindsOf(state, multiBranch),
    since: lastAt === null ? null : new Date(toMs(lastAt)).toISOString(),
    last_kind: lastKind,
    missing_time_out: missingTimeOut,
  };
}

type OrderInfo = KindInfo & { punch_state?: PosPunchState };

/** The "now" the punch ORDER is judged at: the device wall clock corrected by the learned server offset — the SAME clock
 * the punch itself is stamped with (attendanceKiosk.ts serverClock.nowMs()), never the raw device clock, so a tablet
 * whose date is wrong neither auto-closes a shift nor keeps one open past the 16 h limit. */
export const punchRuleNow = (deviceWallMs: number, serverOffsetMs: number): number => deviceWallMs + serverOffsetMs;

/**
 * The punch buttons to show now. The employee's cached `punch_state` (the server's, or advanced by this tablet's own
 * punches) is re-judged with the local rule at `now`, so a shift open > the limit offers IN again offline. No
 * `punch_state` (older server) → null: the caller falls back to every kind as before.
 */
export function allowedKindsFor(e: OrderInfo, now: Date | string | number, openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS): PosPunchKind[] | null {
  const ps = e.punch_state;
  if (!ps) return null;
  return allowedKindsAfter(ps.last_kind, ps.since, now, e.multi_branch === true, openShiftLimitHours);
}

/** The big button among the allowed kinds: the usual suggestion when it is allowed, else OUT, else the first allowed. */
export function suggestedAmong(e: KindInfo, allowed: readonly PosPunchKind[]): PosPunchKind {
  const s = suggestedKindOf(e);
  if (allowed.includes(s)) return s;
  return allowed.includes('OUT') ? 'OUT' : allowed[0] ?? s;
}

/** The cached entry after a punch on this tablet (offline too) — until the server's next list says otherwise. */
export function afterPunch<E extends OrderInfo>(e: E, kind: PosPunchKind, at: Date | string = new Date(), openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS): E {
  const next: E = { ...e, last_kind: kind, suggested_kind: onTheClockAfter(kind) ? 'OUT' : 'IN' };
  // Only an entry that carries the server's punch order (a newer server) gets one; an older server's stays without.
  if (e.punch_state) next.punch_state = punchStateAfter(kind, at, toMs(at), e.multi_branch === true, openShiftLimitHours);
  return next;
}

/**
 * The server's entry advanced by this tablet's own punches the list may not know yet (still unsent): every local punch
 * NEWER than the entry's `since` is applied, oldest first. A punch the server already has is not newer, so it is skipped.
 */
export function withLocalPunches<E extends OrderInfo>(e: E, local: readonly { kind: PosPunchKind; deviceTime: string }[], openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS): E {
  const ps = e.punch_state;
  const sinceMs = ps ? (ps.since ? toMs(ps.since) : -Infinity) : -Infinity;
  return [...local]
    .filter((p) => toMs(p.deviceTime) > sinceMs)
    .sort((a, b) => toMs(a.deviceTime) - toMs(b.deviceTime))
    .reduce((acc, p) => afterPunch(acc, p.kind, p.deviceTime, openShiftLimitHours), e);
}

/** The list's `open_shift_limit_hours` when it is a sane positive number, else the default 16. */
export const openShiftLimitOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_OPEN_SHIFT_LIMIT_HOURS);

export type QueueRow = { user_id: number; kind: PosPunchKind; deviceTime: string; status: string };

/** This tablet's own punches to re-apply on a list refresh: PENDING (any age) or RECORDED within `windowMs` (default 24 h)
 * — a punch uploaded between the list read and the queue read must not vanish from both. Grouped per employee. */
export function ownPunchesForRefresh(rows: readonly QueueRow[], nowMs: number, windowMs: number = 24 * 3_600_000): Map<number, { kind: PosPunchKind; deviceTime: string }[]> {
  const out = new Map<number, { kind: PosPunchKind; deviceTime: string }[]>();
  for (const r of rows) {
    if (r.status !== 'PENDING' && !(r.status === 'RECORDED' && nowMs - toMs(r.deviceTime) <= windowMs)) continue;
    const list = out.get(r.user_id) ?? [];
    list.push({ kind: r.kind, deviceTime: r.deviceTime });
    out.set(r.user_id, list);
  }
  return out;
}

/** One entry of the PIN step's `unsent_punches` (server contract, additive): a not-yet-uploaded punch of this tablet for one person. */
export interface UnsentPunch {
  kind: PosPunchKind;
  device_time: string;
}
export const MAX_UNSENT_PUNCHES = 20;

/** The unsent (PENDING) punches of ONE employee, oldest first, at most the newest 20. */
export function unsentPunchesFor(rows: readonly QueueRow[], userId: number): UnsentPunch[] {
  return rows
    .filter((r) => r.user_id === userId && r.status === 'PENDING')
    .sort((a, b) => toMs(a.deviceTime) - toMs(b.deviceTime))
    .slice(-MAX_UNSENT_PUNCHES)
    .map((r) => ({ kind: r.kind, device_time: r.deviceTime }));
}

/** The grid's status line under a name ('' = nothing to say). With `now` and a punch order, a shift open too long reads as off. */
export function workStatusOf(e: OrderInfo, now?: Date | string | number, openShiftLimitHours: number = DEFAULT_OPEN_SHIFT_LIMIT_HOURS): string {
  const ps = e.punch_state;
  if (ps && now !== undefined) {
    const { state } = punchOrderStateAfter(ps.last_kind, ps.since, now, e.multi_branch === true, openShiftLimitHours);
    return state === 'ON_BREAK' ? 'On break' : state === 'IN_TRANSPORT' ? 'Travelling' : state === 'WORKING' ? 'At work' : '';
  }
  if (e.last_kind === 'BREAK_OUT') return 'On break';
  if (e.last_kind === 'TRANSPORT_OUT' && e.multi_branch === true) return 'Travelling';
  return e.suggested_kind === 'OUT' ? 'At work' : '';
}

/** Used when the server's capture rules aren't cached yet (the server's own defaults). */
export const DEFAULT_CAPTURE: PosAttendanceCapture = { min_frames: 2, max_frames: 3, max_side_px: 640, jpeg_quality: 0.85, max_frame_bytes: 307200 };

export type SkippedReason = 'NO_CAMERA' | 'PERMISSION_DENIED' | 'ENGINE_FAILED' | 'TIMEOUT' | 'OTHER';

/** A frame file on this tablet, as listed in a queued punch. */
export interface QueuedFrame {
  index: number;
  step: AttendanceFrameStep;
  sha256: string;
  /** Absolute path (for deleting) and file:// URI (for uploading) of the same file. */
  path: string;
  uri: string;
  bytes: number;
}

/**
 * A device challenge for an OFFLINE punch: 2 distinct steps in random order (so it always contains a turn), like the
 * server's randomChallenge. `randomInt(n)` must return a uniform integer in [0, n) from a CSPRNG (punchQueue passes
 * expo-crypto bytes).
 */
export function deviceChallenge(randomInt: (n: number) => number): AttendanceLivenessStep[] {
  const pool = [...LIVENESS_STEPS];
  const first = pool.splice(randomInt(pool.length), 1)[0]!;
  const second = pool[randomInt(pool.length)]!;
  return [first, second];
}

/** Uniform integer in [0, n) from random bytes (rejection sampling on one byte; n ≤ 256). */
export function randomIntFromBytes(n: number, nextByte: () => number): number {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('randomInt: n out of range');
  const limit = 256 - (256 % n);
  for (;;) {
    const b = nextByte();
    if (b < limit) return b % n;
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Everything the server's posPunchPayloadSchema checks, before the punch is signed and queued — a payload the server
 * would refuse as malformed must never be queued (it could only ever come back REJECTED). null = fine.
 */
export function punchPayloadProblem(p: PosAttendancePunchPayload, capture: PosAttendanceCapture = DEFAULT_CAPTURE): string | null {
  if (!UUID_V4.test(p.client_uuid)) return 'client_uuid must be a v4 UUID';
  if (!Number.isInteger(p.user_id) || p.user_id < 1) return 'user_id must be a positive integer';
  if (!isPunchKind(p.kind)) return 'kind must be one of ' + PUNCH_KINDS.join(', ');
  if (!ISO_WITH_ZONE.test(p.device_time) || Number.isNaN(Date.parse(p.device_time))) return 'device_time must be ISO-8601 with a zone';
  if (p.ticket !== null && (typeof p.ticket !== 'string' || p.ticket.length < 10 || p.ticket.length > 2000)) return 'ticket is malformed';
  if ((p.ticket === null) !== (p.challenge.source === 'DEVICE')) return 'an online punch uses the server challenge; an offline one its own';
  const steps = p.challenge.steps;
  if (steps.length < 1 || steps.length > 3 || steps.some((s) => !LIVENESS_STEPS.includes(s))) return 'challenge steps are malformed';
  const l = p.liveness;
  if (!['PASSED', 'FAILED', 'SKIPPED'].includes(l.result)) return 'liveness.result is malformed';
  if (l.steps.length > 5 || l.steps.some((s) => s.step.length > 20 || !Number.isInteger(s.duration_ms) || s.duration_ms < 0 || s.duration_ms > 600_000)) {
    return 'liveness.steps are malformed';
  }
  if (!l.engine || l.engine.length > 80) return 'liveness.engine is required (≤ 80 characters)';
  if (l.skipped_reason !== undefined && l.skipped_reason !== null && l.skipped_reason.length > 60) return 'liveness.skipped_reason is too long';
  if (p.frames.length > capture.max_frames) return `at most ${capture.max_frames} photos`;
  const sorted = [...p.frames].sort((a, b) => a.index - b.index);
  if (sorted.some((f, i) => f.index !== i)) return 'photos must be numbered from 0';
  if (sorted.length > 0 && sorted[0]!.step !== 'START') return 'the first photo must be START';
  if (sorted.some((f) => !FRAME_STEPS.includes(f.step) || !SHA256_HEX.test(f.sha256))) return 'photo entries are malformed';
  if (!p.app_version || p.app_version.trim().length > 60) return 'app_version is required';
  return null;
}

export interface BuildPunchInput {
  clientUuid: string;
  userId: number;
  kind: PosPunchKind;
  /** Server-clock-corrected device time of the punch. */
  deviceTime: Date;
  ticket: { ticket: string; steps: AttendanceLivenessStep[] } | null;
  /** Offline only (ignored with a ticket). */
  deviceSteps: AttendanceLivenessStep[];
  liveness: {
    result: 'PASSED' | 'FAILED' | 'SKIPPED';
    skippedReason?: SkippedReason | null;
    steps: { step: AttendanceLivenessStep; passed: boolean; duration_ms: number }[];
    engine: string;
  };
  frames: { index: number; step: AttendanceFrameStep; sha256: string }[];
  appVersion: string;
}

/** The punch payload, ready to sign. Throws when it would be malformed (see punchPayloadProblem). */
export function buildPunchPayload(input: BuildPunchInput, capture: PosAttendanceCapture = DEFAULT_CAPTURE): PosAttendancePunchPayload {
  const liveness: PosAttendancePunchPayload['liveness'] = {
    result: input.liveness.result,
    steps: input.liveness.steps.map((s) => ({ step: s.step, passed: s.passed, duration_ms: Math.max(0, Math.round(s.duration_ms)) })),
    engine: input.liveness.engine,
  };
  // Only a SKIPPED liveness names a reason; never an `undefined` key (canonicalJson would drop it, JSON.parse never has it).
  if (input.liveness.result === 'SKIPPED') liveness.skipped_reason = input.liveness.skippedReason ?? 'OTHER';
  const payload: PosAttendancePunchPayload = {
    client_uuid: input.clientUuid,
    user_id: input.userId,
    kind: input.kind,
    device_time: input.deviceTime.toISOString(),
    ticket: input.ticket ? input.ticket.ticket : null,
    challenge: input.ticket ? { source: 'SERVER', steps: [...input.ticket.steps] } : { source: 'DEVICE', steps: [...input.deviceSteps] },
    liveness,
    frames: [...input.frames].sort((a, b) => a.index - b.index).map((f) => ({ index: f.index, step: f.step, sha256: f.sha256.toLowerCase() })),
    app_version: input.appVersion,
  };
  const problem = punchPayloadProblem(payload, capture);
  if (problem) throw new Error(`The punch can't be saved: ${problem}`);
  return payload;
}

/** The exact text that is signed, stored and sent as the `punch` field. */
export function punchPayloadText(payload: PosAttendancePunchPayload): string {
  return canonicalJson(payload);
}

// ---- the queue row's frames column ---------------------------------------------------------------------------------

export function framesToJson(frames: QueuedFrame[]): string {
  return JSON.stringify(frames.map((f) => ({ index: f.index, step: f.step, sha256: f.sha256, path: f.path, uri: f.uri, bytes: f.bytes })));
}

export function framesFromJson(text: string): QueuedFrame[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('frames_json is not a list');
  return raw.map((r) => {
    const f = r as Record<string, unknown>;
    if (
      typeof f.index !== 'number' ||
      typeof f.step !== 'string' ||
      !FRAME_STEPS.includes(f.step as AttendanceFrameStep) ||
      typeof f.sha256 !== 'string' ||
      typeof f.path !== 'string' ||
      typeof f.uri !== 'string'
    ) {
      throw new Error('frames_json entry is malformed');
    }
    return { index: f.index, step: f.step as AttendanceFrameStep, sha256: f.sha256, path: f.path, uri: f.uri, bytes: typeof f.bytes === 'number' ? f.bytes : 0 };
  });
}

/**
 * A stored punch is still exactly what was signed: its text is canonical, parses to a payload that passes the checks,
 * and lists the same frames (index, step, sha256) as the files row. null = consistent.
 */
export function storedPunchProblem(payloadText: string, frames: QueuedFrame[]): string | null {
  let payload: PosAttendancePunchPayload;
  try {
    payload = JSON.parse(payloadText) as PosAttendancePunchPayload;
  } catch {
    return 'the stored punch is unreadable';
  }
  if (canonicalJson(payload) !== payloadText) return 'the stored punch is not canonical';
  const problem = punchPayloadProblem(payload);
  if (problem) return problem;
  const a = [...payload.frames].sort((x, y) => x.index - y.index);
  const b = [...frames].sort((x, y) => x.index - y.index);
  if (a.length !== b.length || a.some((f, i) => f.index !== b[i]!.index || f.step !== b[i]!.step || f.sha256 !== b[i]!.sha256)) {
    return "the stored photos don't match the signed punch";
  }
  return null;
}

/** The multipart parts for POST /pos/attendance/punches, in order: punch, signature, frame0..n. */
export function punchUploadParts(
  payloadText: string,
  signature: string,
  frames: QueuedFrame[],
): { fields: [string, string][]; files: { name: string; uri: string; type: 'image/jpeg'; filename: string }[] } {
  return {
    fields: [
      ['punch', payloadText],
      ['signature', signature],
    ],
    files: [...frames]
      .sort((a, b) => a.index - b.index)
      .map((f) => ({ name: `frame${f.index}`, uri: f.uri, type: 'image/jpeg' as const, filename: `frame${f.index}.jpg` })),
  };
}

/** "Time in recorded 8:02 AM" (Manila time). */
export function punchMessage(kind: PosPunchKind, at: Date, saved: 'RECORDED' | 'SAVED_ON_TABLET'): string {
  const time = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(at)
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const what = PUNCH_KIND_LABEL[kind] ?? kind;
  return saved === 'RECORDED' ? `${what} recorded ${time}` : `${what} saved ${time}`;
}

/** The server refused an ONLINE punch because its face check wasn't passed (422 LIVENESS_FAILED — nothing stored, the ticket
 * is still usable). Such an attempt is DISCARDED on the tablet (user decision 2026-10-22: photos deleted, no "Not
 * accepted" entry); the code rides in the stored result JSON. */
export function isLivenessRefusal(punch: { status: string; result?: unknown } | null | undefined): boolean {
  return !!punch && punch.status === 'DISCARDED' && (punch.result as { code?: unknown } | null | undefined)?.code === 'LIVENESS_FAILED';
}

/** A 422 LIVENESS_FAILED for an ONLINE punch (it carried a ticket) is discarded; every other refusal is kept. */
export function discardsRefusal(online: boolean, status: number, code: string | null | undefined): boolean {
  return online && status === 422 && code === 'LIVENESS_FAILED';
}
