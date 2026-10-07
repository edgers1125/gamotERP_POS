// The attendance kiosk's liveness challenge, as a pure state machine (no React, no native code) so it can be tested with
// made-up face data (scripts/attendance-selftest.ts). Contract: GamotERP docs/plans/hr-payroll-attendance.md "Kiosk punch
// flow" + pos-api/contract.ts "Attendance kiosk mode".
//
// Input: ML Kit face samples from modules/pos-face (one event per analysed frame: head yaw = Euler Y, eye-open
// probabilities). Output: which frames to capture now ('START' / the step), a plain-language hint, and at the end the
// liveness report the punch carries ({ result, steps: [{ step, passed, duration_ms }] }).
//
//   START       exactly one face, looking straight at the camera (|yaw| ≤ frontalMaxYaw), held startHoldMs → frame 0
//   BLINK       eyes seen open → both closed → open again (frame taken when they reopen)
//   TURN_LEFT   the person's OWN left: own-left yaw ≥ turnMinYaw and moved ≥ turnMinDelta from the START yaw
//   TURN_RIGHT  the same to the person's own right
// Each step has stepTimeoutMs (START: startTimeoutMs); running out = FAILED, and one frame is still taken for the step
// that failed (so a failed punch carries 2+ frames for the reviewer). Several faces / no face never pass a step.
//
// LEFT / RIGHT: ML Kit's headEulerAngleY is positive when the face turns toward the CAMERA's right ("looking to the right
// of the camera"), i.e. the person's OWN left (contract: in the raw, un-mirrored front-camera frame the nose moves toward
// the image's RIGHT edge on TURN_LEFT). OWN_LEFT_YAW_SIGN is that sign in ONE place — if a device test ever shows the
// opposite, flip it here (and only here).
import type { AttendanceFrameStep, AttendanceLivenessStep } from '@pos-api/contract';

export const OWN_LEFT_YAW_SIGN = 1;

export interface LivenessTuning {
  startHoldMs: number;
  startTimeoutMs: number;
  stepTimeoutMs: number;
  /** |yaw| at most this to count as looking straight (START). */
  frontalMaxYaw: number;
  /** A turn: own-side yaw at least this … */
  turnMinYaw: number;
  /** … and moved at least this far from the START yaw. */
  turnMinDelta: number;
  /** Eye-open probability: open at or above, closed at or below. */
  eyeOpen: number;
  eyeClosed: number;
}

export const DEFAULT_TUNING: LivenessTuning = {
  startHoldMs: 500,
  startTimeoutMs: 10_000,
  stepTimeoutMs: 8_000,
  frontalMaxYaw: 12,
  turnMinYaw: 20,
  turnMinDelta: 15,
  eyeOpen: 0.6,
  eyeClosed: 0.3,
};

/** The fields of a face sample the challenge uses (modules/pos-face PosFaceSample has these and more). */
export interface FaceSampleLike {
  yaw: number;
  leftEyeOpen: number; // −1 = unknown
  rightEyeOpen: number;
}

export type LivenessPhase = 'START' | AttendanceLivenessStep | 'PASSED' | 'FAILED';

export interface LivenessUpdate {
  /** Frames to capture NOW, in order (the UI captures them one after another). */
  captures: AttendanceFrameStep[];
  phase: LivenessPhase;
  /** Plain-language instruction for the person (null when finished). */
  hint: string | null;
  /** 0-based index of the current challenge step (−1 during START, steps.length when finished). */
  stepIndex: number;
}

export interface LivenessStepReport {
  step: AttendanceLivenessStep;
  passed: boolean;
  duration_ms: number;
}

export interface LivenessReport {
  result: 'PASSED' | 'FAILED';
  steps: LivenessStepReport[];
}

export const STEP_HINT: Record<AttendanceLivenessStep, string> = {
  BLINK: 'Blink your eyes',
  TURN_LEFT: 'Slowly turn your head to your left',
  TURN_RIGHT: 'Slowly turn your head to your right',
};

/** Own-left yaw: positive = turned to the person's own left. */
export function ownLeftYaw(yaw: number): number {
  return OWN_LEFT_YAW_SIGN * yaw;
}

export class LivenessRun {
  private phase: LivenessPhase = 'START';
  private stepIndex = -1;
  private startedAt: number | null = null; // first tick/feed
  private phaseStartedAt = 0;
  private frontalSince: number | null = null;
  private baselineOwnLeft = 0;
  private eyesSeenOpen = false;
  private eyesSeenClosed = false;
  private hint: string | null = 'Look at the camera';
  private readonly results: LivenessStepReport[] = [];

  constructor(
    readonly steps: AttendanceLivenessStep[],
    private readonly tuning: LivenessTuning = DEFAULT_TUNING,
  ) {
    if (steps.length === 0) throw new Error('A challenge needs at least one step');
  }

  get finished(): boolean {
    return this.phase === 'PASSED' || this.phase === 'FAILED';
  }

  get currentPhase(): LivenessPhase {
    return this.phase;
  }

  /** One analysed frame: every face ML Kit found in it, at time `t` (ms). */
  feed(faces: FaceSampleLike[], t: number): LivenessUpdate {
    const timeout = this.checkTimeout(t);
    if (timeout) return timeout;
    if (this.finished) return this.update([]);

    if (faces.length === 0) {
      this.frontalSince = null;
      this.hint = 'Look at the camera';
      return this.update([]);
    }
    if (faces.length > 1) {
      this.frontalSince = null;
      this.hint = 'Only one person in front of the camera, please';
      return this.update([]);
    }
    const face = faces[0]!;
    const own = ownLeftYaw(face.yaw);

    if (this.phase === 'START') {
      if (Math.abs(face.yaw) > this.tuning.frontalMaxYaw) {
        this.frontalSince = null;
        this.hint = 'Look straight at the camera';
        return this.update([]);
      }
      if (this.frontalSince === null) this.frontalSince = t;
      this.hint = 'Hold still…';
      if (t - this.frontalSince < this.tuning.startHoldMs) return this.update([]);
      this.baselineOwnLeft = own;
      this.beginStep(0, t);
      return this.update(['START']);
    }

    const step = this.phase as AttendanceLivenessStep;
    this.hint = STEP_HINT[step];
    let passed = false;
    if (step === 'BLINK') {
      const known = face.leftEyeOpen >= 0 && face.rightEyeOpen >= 0;
      if (known) {
        const open = Math.min(face.leftEyeOpen, face.rightEyeOpen) >= this.tuning.eyeOpen;
        const closed = Math.max(face.leftEyeOpen, face.rightEyeOpen) <= this.tuning.eyeClosed;
        if (open && !this.eyesSeenOpen) this.eyesSeenOpen = true;
        else if (closed && this.eyesSeenOpen) this.eyesSeenClosed = true;
        else if (open && this.eyesSeenClosed) passed = true;
      }
    } else if (step === 'TURN_LEFT') {
      passed = own >= this.tuning.turnMinYaw && own - this.baselineOwnLeft >= this.tuning.turnMinDelta;
    } else {
      passed = -own >= this.tuning.turnMinYaw && this.baselineOwnLeft - own >= this.tuning.turnMinDelta;
    }
    if (!passed) return this.update([]);
    this.results.push({ step, passed: true, duration_ms: Math.max(0, Math.round(t - this.phaseStartedAt)) });
    if (this.stepIndex + 1 < this.steps.length) this.beginStep(this.stepIndex + 1, t);
    else this.finish('PASSED');
    return this.update([step]);
  }

  /** Clock tick (no frame needed) — lets a step time out even when the camera sends nothing. */
  tick(t: number): LivenessUpdate {
    return this.checkTimeout(t) ?? this.update([]);
  }

  /** The report for the punch: every challenge step in order (steps never reached = not passed, 0 ms). */
  report(): LivenessReport {
    const steps = this.steps.map((step, i) => this.results[i] ?? { step, passed: false, duration_ms: 0 });
    return { result: this.phase === 'PASSED' ? 'PASSED' : 'FAILED', steps };
  }

  private checkTimeout(t: number): LivenessUpdate | null {
    if (this.startedAt === null) {
      this.startedAt = t;
      this.phaseStartedAt = t;
    }
    if (this.finished) return null;
    const limit = this.phase === 'START' ? this.tuning.startTimeoutMs : this.tuning.stepTimeoutMs;
    if (t - this.phaseStartedAt < limit) return null;
    if (this.phase === 'START') {
      // Never got a steady face: still take the START frame and one for the first step, for the reviewer.
      this.finish('FAILED');
      return this.update(['START', this.steps[0]!]);
    }
    const step = this.phase as AttendanceLivenessStep;
    this.results.push({ step, passed: false, duration_ms: Math.max(0, Math.round(t - this.phaseStartedAt)) });
    this.finish('FAILED');
    return this.update([step]);
  }

  private beginStep(index: number, t: number): void {
    this.stepIndex = index;
    this.phase = this.steps[index]!;
    this.phaseStartedAt = t;
    this.eyesSeenOpen = false;
    this.eyesSeenClosed = false;
    this.hint = STEP_HINT[this.phase];
  }

  private finish(result: 'PASSED' | 'FAILED'): void {
    this.phase = result;
    this.stepIndex = this.steps.length;
    this.hint = null;
  }

  private update(captures: AttendanceFrameStep[]): LivenessUpdate {
    return { captures, phase: this.phase, hint: this.hint, stepIndex: this.stepIndex };
  }
}
