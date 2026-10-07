// Self-test of the attendance kiosk's pure logic — no device, no camera, no server, no network:
//   * src/attendance/liveness.ts — the challenge evaluator fed with made-up ML Kit face data (blink, own-left / own-right
//     turns, START hold, several faces, timeouts, the report);
//   * src/attendance/punch.ts — device challenges, the payload the server's posPunchPayloadSchema accepts, the signed
//     canonical text, the queue row's frames column (serialisation round trip + tamper detection), the upload parts and
//     the confirmation wording.
//
// Run from the app root (the repo has no test runner; tsx resolves the @pos-api alias from tsconfig.json):
//   ../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/attendance-selftest.ts
// Exit code 0 = all passed, 1 = a check failed.
import { canonicalJson, type AttendanceLivenessStep, type PosAttendancePunchPayload } from '@pos-api/contract';

import { DEFAULT_TUNING, LivenessRun, OWN_LEFT_YAW_SIGN, type FaceSampleLike } from '../src/attendance/liveness';
import {
  buildPunchPayload,
  deviceChallenge,
  framesFromJson,
  framesToJson,
  punchMessage,
  punchPayloadProblem,
  punchPayloadText,
  punchUploadParts,
  randomIntFromBytes,
  storedPunchProblem,
  type BuildPunchInput,
  type QueuedFrame,
} from '../src/attendance/punch';

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
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---- face data helpers -------------------------------------------------------------------------------------------

/** One face; `ownLeft` = degrees turned to the person's own left (converted to ML Kit's yaw with the app's sign). */
const face = (ownLeft = 0, eyes = 0.95): FaceSampleLike => ({ yaw: OWN_LEFT_YAW_SIGN * ownLeft, leftEyeOpen: eyes, rightEyeOpen: eyes });

/** Feeds frames every 66 ms (~15 fps) from `t`; returns the captures asked for and the last time used. */
function play(run: LivenessRun, t: number, frames: FaceSampleLike[][]): { t: number; captures: string[] } {
  const captures: string[] = [];
  for (const faces of frames) {
    t += 66;
    captures.push(...run.feed(faces, t).captures);
  }
  return { t, captures };
}
const repeat = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
/** Feeds frontal frames with eyes CLOSED until START is captured (so the first step sees no "open" yet). */
function untilStart(run: LivenessRun, t: number): number {
  for (let i = 0; i < 100; i++) {
    t += 66;
    if (run.feed([face(0, 0.05)], t).captures.includes('START')) return t;
  }
  throw new Error('START never captured');
}
const frontal = (n: number) => repeat(n, [face(0)]);
const blink = () => [...repeat(3, [face(0, 0.95)]), ...repeat(3, [face(0, 0.05)]), ...repeat(3, [face(0, 0.95)])];
const turn = (ownLeft: number) => [...repeat(3, [face(ownLeft / 2)]), ...repeat(3, [face(ownLeft)]), ...repeat(3, [face(0)])];

// ---- liveness: happy paths ---------------------------------------------------------------------------------------

{
  // BLINK then TURN_LEFT
  const run = new LivenessRun(['BLINK', 'TURN_LEFT']);
  let r = play(run, 0, frontal(10));
  check('START captured after the hold', r.captures.join() === 'START', r.captures);
  check('after START the phase is BLINK', run.currentPhase === 'BLINK');
  r = play(run, r.t, blink());
  check('blink captured', r.captures.join() === 'BLINK', r.captures);
  check('after BLINK the phase is TURN_LEFT', run.currentPhase === 'TURN_LEFT');
  r = play(run, r.t, turn(30));
  check('turn left captured', r.captures.join() === 'TURN_LEFT', r.captures);
  check('run passed', run.finished && run.currentPhase === 'PASSED');
  const rep = run.report();
  check('report PASSED', rep.result === 'PASSED');
  check('report steps in challenge order', rep.steps.map((s) => s.step).join() === 'BLINK,TURN_LEFT' && rep.steps.every((s) => s.passed));
  check('report durations are whole non-negative ms', rep.steps.every((s) => Number.isInteger(s.duration_ms) && s.duration_ms >= 0 && s.duration_ms < 8000), rep.steps);
}

{
  // TURN_RIGHT then TURN_LEFT (both turns)
  const run = new LivenessRun(['TURN_RIGHT', 'TURN_LEFT']);
  let r = play(run, 1_000, frontal(10));
  r = play(run, r.t, turn(-28)); // own right = negative own-left
  check('turn right passes with a turn to the own right', run.currentPhase === 'TURN_LEFT', run.currentPhase);
  r = play(run, r.t, turn(28));
  check('then turn left passes', run.currentPhase === 'PASSED', run.currentPhase);
  check('captures for both turns', r.captures.join() === 'TURN_LEFT');
}

// ---- liveness: the left/right sign (the person's OWN left) ---------------------------------------------------------

{
  const run = new LivenessRun(['TURN_LEFT', 'BLINK']);
  let r = play(run, 0, frontal(10));
  r = play(run, r.t, turn(-35)); // wrong way: own right
  check('a turn to the own RIGHT does not pass TURN_LEFT', run.currentPhase === 'TURN_LEFT', run.currentPhase);
  r = play(run, r.t, turn(35));
  check('a turn to the own LEFT passes TURN_LEFT', run.currentPhase === 'BLINK', run.currentPhase);
  // ML Kit sign: positive headEulerAngleY = toward the camera's right = the person's own left.
  check('OWN_LEFT_YAW_SIGN is +1 (ML Kit: positive yaw = own left)', OWN_LEFT_YAW_SIGN === 1);
  const raw = new LivenessRun(['TURN_LEFT', 'BLINK']);
  let t = 0;
  for (let i = 0; i < 10; i++) raw.feed([{ yaw: 0, leftEyeOpen: 0.9, rightEyeOpen: 0.9 }], (t += 66));
  for (let i = 0; i < 3; i++) raw.feed([{ yaw: 30, leftEyeOpen: 0.9, rightEyeOpen: 0.9 }], (t += 66));
  check('raw ML Kit yaw +30° passes TURN_LEFT', raw.currentPhase === 'BLINK', raw.currentPhase);
}

{
  // A small turn (below the threshold) doesn't pass; moving from a turned START needs the delta too.
  const run = new LivenessRun(['TURN_LEFT', 'TURN_RIGHT']);
  let r = play(run, 0, frontal(10));
  r = play(run, r.t, repeat(10, [face(DEFAULT_TUNING.turnMinYaw - 5)]));
  check('a small turn does not pass', run.currentPhase === 'TURN_LEFT');
  r = play(run, r.t, repeat(2, [face(DEFAULT_TUNING.turnMinYaw + 2)]));
  check('a turn past the threshold passes', run.currentPhase === 'TURN_RIGHT');
  void r;
}

{
  // START: not frontal → no START; hold resets when the face goes away or a second face appears.
  const run = new LivenessRun(['BLINK', 'TURN_RIGHT']);
  let r = play(run, 0, repeat(20, [face(25)]));
  check('no START while looking away', r.captures.length === 0 && run.currentPhase === 'START');
  check('hint asks to look straight', run.feed([face(25)], r.t + 1).hint === 'Look straight at the camera');
  r = play(run, r.t + 1, [...frontal(4), [], ...frontal(4)]);
  check('hold restarts after the face is lost', r.captures.length === 0, r.captures);
  r = play(run, r.t, [...frontal(4), [face(0), face(0)], ...frontal(4)]);
  check('hold restarts with two faces', r.captures.length === 0, r.captures);
  check('two faces → one-person hint', run.feed([face(0), face(0)], r.t + 1).hint?.includes('Only one person') === true);
  r = play(run, r.t + 1, frontal(10));
  check('START after a clean hold', r.captures.join() === 'START');
}

{
  // BLINK needs open → closed → open; unknown eye probabilities (−1) are ignored; closed-at-start doesn't count.
  const run = new LivenessRun(['BLINK', 'TURN_LEFT']);
  let r = { t: untilStart(run, 0), captures: [] as string[] };
  r = play(run, r.t, [...repeat(3, [face(0, 0.05)]), ...repeat(3, [face(0, 0.95)])]);
  check('closed then open (no open first) is not a blink', run.currentPhase === 'BLINK');
  r = play(run, r.t, [...repeat(3, [face(0, 0.05)]), ...repeat(3, [face(0, -1)])]);
  check('unknown eyes do not complete a blink', run.currentPhase === 'BLINK');
  r = play(run, r.t, repeat(2, [face(0, 0.95)]));
  check('reopening completes the blink', run.currentPhase === 'TURN_LEFT');
  // One eye closed only (a wink at 0.5) is not "both closed".
  const run2 = new LivenessRun(['BLINK', 'TURN_LEFT']);
  let r2 = play(run2, 0, frontal(10));
  r2 = play(run2, r2.t, [
    ...repeat(3, [face(0, 0.95)]),
    ...repeat(3, [{ yaw: 0, leftEyeOpen: 0.05, rightEyeOpen: 0.9 }]),
    ...repeat(3, [face(0, 0.95)]),
  ]);
  check('one eye closed is not a blink', run2.currentPhase === 'BLINK');
  void r2;
}

{
  // Several faces never pass a step.
  const run = new LivenessRun(['TURN_LEFT', 'BLINK']);
  let r = play(run, 0, frontal(10));
  r = play(run, r.t, repeat(5, [face(40), face(0)]));
  check('two faces during a step never pass', run.currentPhase === 'TURN_LEFT');
  void r;
}

// ---- liveness: timeouts -----------------------------------------------------------------------------------------

{
  const run = new LivenessRun(['BLINK', 'TURN_LEFT']);
  const r = play(run, 0, frontal(10));
  const u = run.tick(r.t + DEFAULT_TUNING.stepTimeoutMs + 1);
  check('step timeout → FAILED', run.currentPhase === 'FAILED');
  check('step timeout still captures that step', u.captures.join() === 'BLINK', u.captures);
  const rep = run.report();
  check('failed report', rep.result === 'FAILED' && rep.steps.length === 2 && !rep.steps[0]!.passed && rep.steps[0]!.duration_ms >= DEFAULT_TUNING.stepTimeoutMs && !rep.steps[1]!.passed && rep.steps[1]!.duration_ms === 0, rep);
  check('feed after the end asks nothing', run.feed([face(0)], r.t + 20_000).captures.length === 0);
}

{
  const run = new LivenessRun(['TURN_RIGHT', 'BLINK']);
  run.tick(0);
  const u = run.tick(DEFAULT_TUNING.startTimeoutMs + 1);
  check('START timeout → FAILED with START + first step frames', run.currentPhase === 'FAILED' && u.captures.join() === 'START,TURN_RIGHT', u.captures);
  check('START timeout report: nothing passed', run.report().steps.every((s) => !s.passed));
}

{
  const run = new LivenessRun(['TURN_LEFT', 'TURN_RIGHT']);
  let r = play(run, 0, frontal(10));
  r = play(run, r.t, turn(30));
  const u = run.tick(r.t + DEFAULT_TUNING.stepTimeoutMs + 5);
  const rep = run.report();
  check('second step timeout: first passed, second failed', rep.result === 'FAILED' && rep.steps[0]!.passed && !rep.steps[1]!.passed && u.captures.join() === 'TURN_RIGHT', rep);
}

check('an empty challenge is refused', throws(() => new LivenessRun([])));

// ---- device challenge + randomness ------------------------------------------------------------------------------

{
  const seen = new Set<string>();
  let seq = 0;
  const bytes = Array.from({ length: 4000 }, (_, i) => (i * 97 + 13) % 256);
  for (let i = 0; i < 400; i++) {
    const c = deviceChallenge((n) => randomIntFromBytes(n, () => bytes[seq++ % bytes.length]!));
    seen.add(c.join());
    if (c.length !== 2 || c[0] === c[1]) check('device challenge = 2 distinct steps', false, c);
    if (!c.some((s) => s !== 'BLINK')) check('device challenge contains a turn', false, c);
  }
  check('all 6 orderings occur', seen.size === 6, [...seen]);
  // rejection sampling: never biased (255 not < 255 for n=3 → skipped)
  const out = randomIntFromBytes(3, (() => {
    const q = [255, 7];
    return () => q.shift()!;
  })());
  check('randomIntFromBytes skips biased bytes', out === 7 % 3, out);
  check('randomIntFromBytes refuses n out of range', throws(() => randomIntFromBytes(0, () => 1)) && throws(() => randomIntFromBytes(300, () => 1)));
}

// ---- payload ----------------------------------------------------------------------------------------------------

const SHA = (c: string) => c.repeat(64).slice(0, 64);
const frames: QueuedFrame[] = [
  { index: 0, step: 'START', sha256: SHA('a'), path: '/data/user/0/x/files/attendance_frames/1.jpg', uri: 'file:///data/user/0/x/files/attendance_frames/1.jpg', bytes: 51_234 },
  { index: 1, step: 'BLINK', sha256: SHA('b'), path: '/data/user/0/x/files/attendance_frames/2.jpg', uri: 'file:///data/user/0/x/files/attendance_frames/2.jpg', bytes: 49_000 },
  { index: 2, step: 'TURN_LEFT', sha256: SHA('c'), path: '/data/user/0/x/files/attendance_frames/3.jpg', uri: 'file:///data/user/0/x/files/attendance_frames/3.jpg', bytes: 50_100 },
];
const steps: AttendanceLivenessStep[] = ['BLINK', 'TURN_LEFT'];
const base: BuildPunchInput = {
  clientUuid: '3b241101-e2bb-4255-8caf-4136c566a962',
  userId: 42,
  kind: 'IN',
  deviceTime: new Date('2026-10-05T00:02:00.000Z'),
  ticket: null,
  deviceSteps: steps,
  liveness: { result: 'PASSED', steps: steps.map((s) => ({ step: s, passed: true, duration_ms: 1234.4 })), engine: 'mlkit-face-detection@16.1.7' },
  frames: frames.map((f) => ({ index: f.index, step: f.step, sha256: f.sha256 })),
  appVersion: '1.0.0',
};

{
  const offline = buildPunchPayload(base);
  check('offline punch: ticket null + DEVICE challenge', offline.ticket === null && offline.challenge.source === 'DEVICE' && offline.challenge.steps.join() === 'BLINK,TURN_LEFT');
  check('offline payload passes the checks', punchPayloadProblem(offline) === null, punchPayloadProblem(offline));
  check('durations rounded', offline.liveness.steps.every((s) => s.duration_ms === 1234));
  check('no skipped_reason key unless SKIPPED', !('skipped_reason' in offline.liveness));
  check('device_time is ISO UTC', offline.device_time === '2026-10-05T00:02:00.000Z');

  const online = buildPunchPayload({ ...base, ticket: { ticket: 'eyJ2IjoxfQ.abcdefghijk', steps: ['TURN_RIGHT', 'BLINK'] } });
  check('online punch: SERVER challenge = the ticket steps', online.challenge.source === 'SERVER' && online.challenge.steps.join() === 'TURN_RIGHT,BLINK');

  const skipped = buildPunchPayload({ ...base, liveness: { result: 'SKIPPED', skippedReason: 'PERMISSION_DENIED', steps: [], engine: 'none' }, frames: [] });
  check('skipped: reason kept, no frames', skipped.liveness.skipped_reason === 'PERMISSION_DENIED' && skipped.frames.length === 0 && punchPayloadProblem(skipped) === null);

  // What the server refuses must never be queued.
  check('refuses a non-v4 uuid', throws(() => buildPunchPayload({ ...base, clientUuid: 'not-a-uuid' })));
  check('refuses frames not starting with START', throws(() => buildPunchPayload({ ...base, frames: [{ index: 0, step: 'BLINK', sha256: SHA('a') }] })));
  check('refuses frame gaps', throws(() => buildPunchPayload({ ...base, frames: [{ index: 0, step: 'START', sha256: SHA('a') }, { index: 2, step: 'BLINK', sha256: SHA('b') }] })));
  check('refuses 4 frames', throws(() => buildPunchPayload({ ...base, frames: [...base.frames, { index: 3, step: 'TURN_RIGHT', sha256: SHA('d') }] })));
  check('refuses a bad sha256', throws(() => buildPunchPayload({ ...base, frames: [{ index: 0, step: 'START', sha256: 'xyz' }] })));
  check('refuses an empty engine', throws(() => buildPunchPayload({ ...base, liveness: { ...base.liveness, engine: '' } })));
  check('refuses an empty challenge', throws(() => buildPunchPayload({ ...base, deviceSteps: [] })));
  check('upper-case sha256 is normalised', buildPunchPayload({ ...base, frames: [{ index: 0, step: 'START', sha256: SHA('A') }] }).frames[0]!.sha256 === SHA('a'));
  const mixed = { ...offline, ticket: 'eyJ2IjoxfQ.abcdefghijk' } as PosAttendancePunchPayload;
  check('a ticket with a DEVICE challenge is malformed', punchPayloadProblem(mixed) !== null);

  // The signed text: canonical, and what the server re-derives from the sent field.
  const text = punchPayloadText(offline);
  check('signed text = canonicalJson(JSON.parse(text))', canonicalJson(JSON.parse(text)) === text);
  check('signed text has sorted keys', text.startsWith('{"app_version":'));
}

// ---- queue row: frames column + tamper detection -----------------------------------------------------------------

{
  const payload = buildPunchPayload(base);
  const text = punchPayloadText(payload);
  const stored = framesToJson(frames);
  const back = framesFromJson(stored);
  check('frames round trip', JSON.stringify(back) === JSON.stringify(frames), back);
  check('a consistent stored punch passes', storedPunchProblem(text, back) === null, storedPunchProblem(text, back));
  check('a re-serialised (non-canonical) text is caught', storedPunchProblem(JSON.stringify(payload, null, 1), back) !== null);
  const tampered = text.replace('"user_id":42', '"user_id":43');
  check('a changed payload still passes shape checks (the server rejects it by signature)', storedPunchProblem(tampered, back) === null);
  const swapped = back.map((f) => (f.index === 1 ? { ...f, sha256: SHA('d') } : f));
  check('a swapped photo is caught', storedPunchProblem(text, swapped) !== null);
  check('a missing photo is caught', storedPunchProblem(text, back.slice(0, 2)) !== null);
  check('unreadable frames_json throws', throws(() => framesFromJson('{"x":1}')) && throws(() => framesFromJson('[{"index":0}]')));

  const parts = punchUploadParts(text, 'h.p.s', [...back].reverse());
  check('upload fields: punch then signature', parts.fields[0]![0] === 'punch' && parts.fields[0]![1] === text && parts.fields[1]![0] === 'signature');
  check('upload files frame0..2 in order', parts.files.map((f) => f.name).join() === 'frame0,frame1,frame2' && parts.files.every((f) => f.type === 'image/jpeg'));
}

// ---- wording ----------------------------------------------------------------------------------------------------

check('Time in recorded 8:02 AM', punchMessage('IN', new Date('2026-10-05T00:02:00Z'), 'RECORDED') === 'Time in recorded 8:02 AM', punchMessage('IN', new Date('2026-10-05T00:02:00Z'), 'RECORDED'));
check('Time out recorded 5:30 PM', punchMessage('OUT', new Date('2026-10-05T09:30:00Z'), 'RECORDED') === 'Time out recorded 5:30 PM', punchMessage('OUT', new Date('2026-10-05T09:30:00Z'), 'RECORDED'));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
