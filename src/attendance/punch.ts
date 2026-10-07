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
  type PosAttendancePunchPayload,
} from '@pos-api/contract';

export const LIVENESS_STEPS: readonly AttendanceLivenessStep[] = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT'];
const FRAME_STEPS: readonly AttendanceFrameStep[] = ['START', ...LIVENESS_STEPS];

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
  if (p.kind !== 'IN' && p.kind !== 'OUT') return 'kind must be IN or OUT';
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
  kind: 'IN' | 'OUT';
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
export function punchMessage(kind: 'IN' | 'OUT', at: Date, saved: 'RECORDED' | 'SAVED_ON_TABLET'): string {
  const time = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(at)
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const what = kind === 'IN' ? 'Time in' : 'Time out';
  return saved === 'RECORDED' ? `${what} recorded ${time}` : `${what} saved ${time}`;
}
