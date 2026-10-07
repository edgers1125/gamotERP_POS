// The attendance kiosk's camera step: a mirrored front-camera preview (modules/pos-face), the 2-step liveness challenge
// run by src/attendance/liveness.ts on ML Kit's face data, and 2–3 photos taken DURING it (START, then one per step).
// Hands back the liveness report + the saved frame files; never blocks a punch: no camera / permission refused / the
// engine failing → "Record without photo" (liveness SKIPPED, the server flags LIVENESS_SKIPPED); a challenge that
// times out → "Try again" or "Record anyway" (FAILED, flagged LIVENESS_FAILED).
import { useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import type { AttendanceFrameStep, AttendanceLivenessStep, PosAttendanceCapture } from '@pos-api/contract';

import PosFace, { PosFaceCameraView, type PosFaceCameraViewRef, type PosFacesEvent } from '../../../modules/pos-face';
import { discardFrames } from '../../attendance/attendanceKiosk';
import { LivenessRun, STEP_HINT, type LivenessStepReport, type LivenessUpdate } from '../../attendance/liveness';
import type { QueuedFrame, SkippedReason } from '../../attendance/punch';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { Banner, Button } from '../../ui/components';
import { radius, spacing } from '../../ui/theme';

export interface LivenessOutcome {
  liveness: {
    result: 'PASSED' | 'FAILED' | 'SKIPPED';
    skippedReason?: SkippedReason;
    steps: LivenessStepReport[];
    engine: string;
  };
  frames: QueuedFrame[];
}

const CAMERA_START_TIMEOUT_MS = 8_000;
const TICK_MS = 250;

/** 'none' when this build has no face engine (Expo Go) — the server only needs a non-empty string. */
const ENGINE = PosFace ? PosFace.engine() : 'none';

type Phase =
  | { kind: 'checking' }
  | { kind: 'unavailable'; reason: SkippedReason; message: string; canRetry: boolean }
  | { kind: 'running' }
  | { kind: 'failed'; steps: LivenessStepReport[]; frames: QueuedFrame[] };

export function LivenessCapture({
  steps,
  capture,
  onDone,
  onCancel,
  onActivity,
}: {
  steps: AttendanceLivenessStep[];
  capture: PosAttendanceCapture;
  onDone: (outcome: LivenessOutcome) => void;
  onCancel: () => void;
  /** Called while the person is in front of the camera (keeps the kiosk's idle timer from resetting). */
  onActivity?: () => void;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const askedRef = useRef(false);

  const skip = useCallback(
    (reason: SkippedReason) => onDone({ liveness: { result: 'SKIPPED', skippedReason: reason, steps: [], engine: ENGINE }, frames: [] }),
    [onDone],
  );

  // Can this tablet do it at all? (module in the build, a front camera, the permission)
  useEffect(() => {
    if (phase.kind !== 'checking') return;
    if (!PosFace || !PosFaceCameraView) {
      setPhase({ kind: 'unavailable', reason: 'ENGINE_FAILED', message: "This app build can't use the camera for attendance.", canRetry: false });
      return;
    }
    if (!permission) return; // still loading
    if (!permission.granted) {
      if (permission.canAskAgain) {
        // Ask once by ourselves; after a "Don't allow" the buttons below ask again or record without a photo.
        if (!askedRef.current) {
          askedRef.current = true;
          void requestPermission();
        }
        return;
      }
      setPhase({
        kind: 'unavailable',
        reason: 'PERMISSION_DENIED',
        message: 'The camera is not allowed for this app. A manager can allow it in Android Settings → Apps → GamotERP POS → Permissions → Camera.',
        canRetry: true,
      });
      return;
    }
    let alive = true;
    PosFace.hasFrontCamera()
      .then((has) => {
        if (!alive) return;
        if (has) setPhase({ kind: 'running' });
        else setPhase({ kind: 'unavailable', reason: 'NO_CAMERA', message: 'This tablet has no front camera.', canRetry: false });
      })
      .catch(() => alive && setPhase({ kind: 'running' }));
    return () => {
      alive = false;
    };
  }, [phase.kind, permission, requestPermission]);

  // A permission refused in the system dialog (but still askable) lands here.
  useEffect(() => {
    if (phase.kind === 'checking' && permission && !permission.granted && !permission.canAskAgain) {
      setPhase({
        kind: 'unavailable',
        reason: 'PERMISSION_DENIED',
        message: 'The camera is not allowed for this app. A manager can allow it in Android Settings → Apps → GamotERP POS → Permissions → Camera.',
        canRetry: true,
      });
    }
  }, [phase.kind, permission]);

  if (phase.kind === 'checking') {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>Starting the camera…</Text>
        {permission && !permission.granted && permission.canAskAgain ? (
          <View style={styles.actions}>
            <Text style={styles.body}>Allow the camera so the punch has a photo.</Text>
            <Button title="Allow camera" onPress={() => void requestPermission()} />
            <Button title="Record without photo" variant="secondary" onPress={() => skip('PERMISSION_DENIED')} />
          </View>
        ) : null}
      </View>
    );
  }

  if (phase.kind === 'unavailable') {
    return (
      <View style={styles.center}>
        <Banner kind="warning" title="No photo this time" message={`${phase.message} You can still record the punch — HR will review it.`} style={styles.banner} />
        <View style={styles.actionsRow}>
          <Button title="Record without photo" onPress={() => skip(phase.reason)} />
          {phase.canRetry ? (
            <Button
              title="Try again"
              variant="secondary"
              onPress={() => {
                if (phase.reason === 'PERMISSION_DENIED') void requestPermission();
                setPhase({ kind: 'checking' });
              }}
            />
          ) : null}
          <Button title="Cancel" variant="ghost" onPress={onCancel} />
        </View>
      </View>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <View style={styles.center}>
        <Banner
          kind="warning"
          title="We couldn't confirm the movement"
          message="Try again, looking straight at the camera with your face in the oval. Or record the punch now — HR will review it."
          style={styles.banner}
        />
        <View style={styles.actionsRow}>
          <Button
            title="Try again"
            onPress={() => {
              void discardFrames(phase.frames);
              setAttempt((n) => n + 1);
              setPhase({ kind: 'running' });
            }}
          />
          <Button
            title="Record anyway"
            variant="secondary"
            onPress={() => onDone({ liveness: { result: 'FAILED', steps: phase.steps, engine: ENGINE }, frames: phase.frames })}
          />
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => {
              void discardFrames(phase.frames);
              onCancel();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <ChallengeRunner
      key={attempt}
      steps={steps}
      capture={capture}
      color={c.primary}
      onActivity={onActivity}
      onPassed={(report, frames) => onDone({ liveness: { result: 'PASSED', steps: report, engine: ENGINE }, frames })}
      onFailed={(report, frames) => setPhase({ kind: 'failed', steps: report, frames })}
      onUnavailable={(reason, message) => setPhase({ kind: 'unavailable', reason, message, canRetry: true })}
      onCancel={(frames) => {
        void discardFrames(frames);
        onCancel();
      }}
    />
  );
}

function ChallengeRunner({
  steps,
  capture,
  color,
  onActivity,
  onPassed,
  onFailed,
  onUnavailable,
  onCancel,
}: {
  steps: AttendanceLivenessStep[];
  capture: PosAttendanceCapture;
  color: string;
  onActivity?: () => void;
  onPassed: (report: LivenessStepReport[], frames: QueuedFrame[]) => void;
  onFailed: (report: LivenessStepReport[], frames: QueuedFrame[]) => void;
  onUnavailable: (reason: SkippedReason, message: string) => void;
  onCancel: (frames: QueuedFrame[]) => void;
}) {
  const styles = useStyles();
  const cameraRef = useRef<PosFaceCameraViewRef | null>(null);
  const runRef = useRef(new LivenessRun(steps));
  const framesRef = useRef<QueuedFrame[]>([]);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const doneRef = useRef(false);
  const readyRef = useRef(false);
  const [hint, setHint] = useState<string>('Look at the camera');
  const [stepIndex, setStepIndex] = useState(-1);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const quality = Math.round(Math.min(1, Math.max(0.4, capture.jpeg_quality)) * 100);

  const takeFrame = useCallback(
    (step: AttendanceFrameStep) => {
      chainRef.current = chainRef.current.then(async () => {
        const cam = cameraRef.current;
        if (!cam) return;
        let frame = null;
        for (let i = 0; i < 2 && !frame; i++) {
          try {
            frame = await cam.captureFrame(capture.max_side_px, quality, capture.max_frame_bytes);
          } catch {
            frame = null;
          }
        }
        if (!frame) return; // a missing photo: the rest stay numbered in order (checked at the end)
        if (framesRef.current.length >= capture.max_frames) {
          void discardFrames([frame]);
          return;
        }
        framesRef.current.push({ index: framesRef.current.length, step, sha256: frame.sha256, path: frame.path, uri: frame.uri, bytes: frame.bytes });
      });
    },
    [capture.max_frames, capture.max_frame_bytes, capture.max_side_px, quality],
  );

  const handle = useCallback(
    (u: LivenessUpdate) => {
      if (doneRef.current) return;
      for (const s of u.captures) takeFrame(s);
      setHint(u.hint ?? '');
      setStepIndex(u.stepIndex);
      if (u.phase !== 'PASSED' && u.phase !== 'FAILED') return;
      doneRef.current = true;
      setSaving(true);
      const report = runRef.current.report().steps;
      void chainRef.current.then(() => {
        const frames = framesRef.current;
        // Photos must start with START and be numbered 0..n-1 — otherwise send none (camera trouble, flagged by HR).
        if (frames.length === 0 || frames[0]!.step !== 'START') {
          void discardFrames(frames);
          onUnavailable('ENGINE_FAILED', "The photos couldn't be taken.");
          return;
        }
        if (u.phase === 'PASSED') onPassed(report, frames);
        else onFailed(report, frames);
      });
    },
    [onFailed, onPassed, onUnavailable, takeFrame],
  );

  // Clock: steps time out even when no frames arrive; the camera must start within a few seconds.
  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!readyRef.current) {
        if (Date.now() - startedAt > CAMERA_START_TIMEOUT_MS && !doneRef.current) {
          doneRef.current = true;
          onUnavailable('TIMEOUT', "The camera didn't start.");
        }
        return;
      }
      handle(runRef.current.tick(Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [handle, onUnavailable]);

  const onFaces = useCallback(
    (e: { nativeEvent: PosFacesEvent }) => {
      if (!readyRef.current || doneRef.current) return;
      if (e.nativeEvent.faces.length > 0) onActivity?.();
      handle(runRef.current.feed(e.nativeEvent.faces, Date.now()));
    },
    [handle, onActivity],
  );

  const Camera = PosFaceCameraView!;
  const current = stepIndex >= 0 && stepIndex < steps.length ? steps[stepIndex]! : null;
  const arrow = current === 'TURN_LEFT' ? '←' : current === 'TURN_RIGHT' ? '→' : null;
  return (
    <View style={styles.runner}>
      <View style={styles.cameraBox}>
        <Camera
          ref={cameraRef}
          active={!saving}
          style={styles.camera}
          onCameraReady={() => {
            readyRef.current = true;
            setReady(true);
          }}
          onCameraError={(e) => {
            if (doneRef.current) return;
            doneRef.current = true;
            onUnavailable(e.nativeEvent.code === 'NO_CAMERA' ? 'NO_CAMERA' : 'ENGINE_FAILED', e.nativeEvent.message);
          }}
          onFaces={onFaces}
        />
        <View pointerEvents="none" style={[styles.oval, { borderColor: color }]} />
        {arrow ? (
          // The preview is mirrored, so the person's own left is the screen's left.
          <Text pointerEvents="none" style={[styles.arrow, current === 'TURN_LEFT' ? styles.arrowLeft : styles.arrowRight]}>
            {arrow}
          </Text>
        ) : null}
      </View>
      <View style={styles.side}>
        <Text style={styles.hint}>{saving ? 'Saving…' : ready ? hint : 'Starting the camera…'}</Text>
        <View style={styles.stepsList}>
          {steps.map((s, i) => (
            <View key={`${s}-${i}`} style={styles.stepRow}>
              <View style={[styles.stepDot, i < stepIndex || stepIndex >= steps.length ? styles.stepDotDone : i === stepIndex ? styles.stepDotNow : null]} />
              <Text style={[styles.stepText, i === stepIndex ? styles.stepTextNow : null]}>{STEP_HINT[s]}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.caption}>Photos are taken during these steps for HR's attendance check.</Text>
        <Button
          title="Cancel"
          variant="ghost"
          disabled={saving}
          onPress={() => {
            doneRef.current = true;
            void chainRef.current.then(() => onCancel(framesRef.current));
          }}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  banner: { alignSelf: 'stretch', maxWidth: 720 },
  actions: { alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md },
  body: { ...t.body, textAlign: 'center' },
  runner: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xl, padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  cameraBox: {
    width: 420,
    maxWidth: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: c.camera,
    alignItems: 'center',
    justifyContent: 'center',
  },
  camera: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  oval: { width: '62%', height: '66%', borderRadius: 999, borderWidth: 4, opacity: 0.85 },
  arrow: { position: 'absolute', top: '42%', fontSize: 72, color: '#ffffff' },
  arrowLeft: { left: spacing.lg },
  arrowRight: { right: spacing.lg },
  side: { minWidth: 260, maxWidth: 420, flexShrink: 1, gap: spacing.lg },
  hint: { ...t.title, fontSize: 28, color: c.text },
  stepsList: { gap: spacing.sm },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: c.borderStrong },
  stepDotNow: { borderColor: c.primary, backgroundColor: c.primarySoftStrong },
  stepDotDone: { borderColor: c.success, backgroundColor: c.success },
  stepText: { ...t.body, color: c.muted },
  stepTextNow: { ...t.bodyStrong, color: c.text },
  caption: { ...t.caption },
}));
