// Attendance kiosk mode (CLAUDE.md "Attendance kiosk mode"; GamotERP docs/plans/hr-payroll-attendance.md "Kiosk punch
// flow"): shown on the LOCKED till of a terminal HR made an attendance kiosk — nothing here can sell. Flow:
//   person (grid of names + initials, search) → Time in / Time out (the suggested one big) → PIN (online: checked by
//   the server, which answers a ticket + the liveness challenge; offline — no answer at all — skipped, the server flags
//   PIN_NOT_CHECKED; 403 SUBSCRIPTION_LOCKED → no punch, paused + a forced check-in, never the offline path) →
//   camera: the 2-step challenge with photos (LivenessCapture) → saved on the tablet + sent → "Time in recorded 8:02 AM"
//   → back to the list after a few seconds. Any screen left untouched for 45 s goes back to the list.
// Every punch is saved (signed, with its photos) BEFORE it is sent; unsent ones go out with the next check-in.
// Also the Attendance section of a signed-in till and the whole app of an attendance-only tablet (GamotERP
// docs/plans/attendance-pos-only.md). Nobody punches until HR set them up (PIN + reference photo — not-ready names are
// greyed out), and NEW punches stop while the device is revoked / too old / the subscription is LOCKED / the lease expired
// (src/db/policy.ts attendanceBlockReason); saved ones still upload.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';

import type { AttendanceLivenessStep, PosAttendanceEmployee } from '@pos-api/contract';

import { attendanceApi } from '../api/client';
import {
  getPunch,
  loadKiosk,
  newDeviceChallenge,
  pruneFrames,
  pushPunches,
  recordPunch,
  refreshKiosk,
  rejectedPunches,
  uploadAndWait,
  useAttendanceKiosk,
  type LocalPunch,
} from '../attendance/attendanceKiosk';
import { DEFAULT_CAPTURE, punchMessage } from '../attendance/punch';
import { LivenessCapture, type LivenessOutcome } from '../components/attendance/LivenessCapture';
import { PIN_MIN, PinPad } from '../components/attendance/PinPad';
import { errorMessage, formatDateTime } from '../components/shell/format';
import { attendanceBlockReason, SUBSCRIPTION_LOCKED_MESSAGE } from '../db/policy';
import { syncEngine, useSyncStatus } from '../sync/syncEngine';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { Banner, Button, TextField } from '../ui/components';
import { radius, spacing } from '../ui/theme';

type Kind = 'IN' | 'OUT';
type Employee = PosAttendanceEmployee;

type Stage =
  | { k: 'grid' }
  | { k: 'kind'; emp: Employee }
  | { k: 'pin'; emp: Employee; kind: Kind }
  | { k: 'camera'; emp: Employee; kind: Kind; ticket: { ticket: string; steps: AttendanceLivenessStep[] } | null; steps: AttendanceLivenessStep[]; note: string | null }
  | { k: 'saving'; emp: Employee; kind: Kind }
  | { k: 'done'; emp: Employee; kind: Kind; headline: string; detail: string | null; tone: 'success' | 'warning' };

const IDLE_RESET_MS = 45_000;
const DONE_RESET_MS = 5_000;
const UPLOAD_WAIT_MS = 12_000;
const kindLabel = (k: Kind) => (k === 'IN' ? 'Time in' : 'Time out');
/** An ApiError's HTTP status (0 = no connection), duck-typed; null for anything else. */
const apiStatus = (e: unknown): number | null =>
  e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null;

/** Not set up for punching (HR: PIN and/or reference photo). An older server's cached list has no `ready` = ready. */
const notReady = (e: Employee) => e.ready === false;
const missingText = (missing: readonly string[] | undefined) =>
  (missing ?? []).map((m) => (m === 'PIN' ? 'attendance PIN' : m === 'REFERENCE_PHOTOS' ? 'reference photo' : m.toLowerCase())).join(' and ') || 'attendance PIN and reference photo';

const manilaClock = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short', month: 'short', day: 'numeric' });

export function AttendanceKioskScreen() {
  const styles = useStyles();
  const kiosk = useAttendanceKiosk((s) => s.kiosk);
  const unsent = useAttendanceKiosk((s) => s.unsent);
  const rejected = useAttendanceKiosk((s) => s.rejected);
  const uploadError = useAttendanceKiosk((s) => s.uploadError);
  const online = useSyncStatus((s) => s.online);
  // Revoked / app too old / LOCKED / lease expired → no new punches (saved ones still upload).
  const statusBlocked = useSyncStatus((s) => attendanceBlockReason({ revoked: s.revoked, updateRequired: s.updateRequired, license: s.license?.code ?? null }));
  // The PIN check just answered 403 SUBSCRIPTION_LOCKED: paused AT ONCE (before the stored license / status catch up —
  // the forced check-in below refreshes them), never "continue offline" (code-review finding: that skipped the PIN and
  // recorded a lock-day punch through the upload route, which stays open while LOCKED).
  const [lockedByServer, setLockedByServer] = useState(false);
  const blocked = statusBlocked ?? (lockedByServer ? SUBSCRIPTION_LOCKED_MESSAGE : null);
  const [stage, setStage] = useState<Stage>({ k: 'grid' });
  const [clock, setClock] = useState(() => manilaClock.format(new Date()));
  const [showRejected, setShowRejected] = useState(false);
  const lastActivity = useRef(Date.now());
  const touch = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  // Fresh list + any waiting punches when the kiosk opens.
  useEffect(() => {
    void loadKiosk().then(() => refreshKiosk({ force: true }));
    void pushPunches().catch(() => undefined);
    void pruneFrames().catch(() => undefined);
  }, []);

  // Clock + idle reset.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(manilaClock.format(new Date()));
      setStage((s) => (s.k !== 'grid' && s.k !== 'saving' && s.k !== 'done' && Date.now() - lastActivity.current > IDLE_RESET_MS ? { k: 'grid' } : s));
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  // Back to the list after the confirmation.
  useEffect(() => {
    if (stage.k !== 'done') return;
    const t = setTimeout(() => setStage({ k: 'grid' }), stage.tone === 'success' ? DONE_RESET_MS : DONE_RESET_MS + 3_000);
    return () => clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    if (blocked) setStage((s) => (s.k === 'saving' || s.k === 'done' ? s : { k: 'grid' }));
  }, [blocked]);

  // 403 SUBSCRIPTION_LOCKED from the PIN check (api/client.ts has already stored the lock — license signal): back to the
  // list, paused, and a forced check-in (heartbeat → license) so the stored state and banners follow the server.
  const onLocked = useCallback(() => {
    setLockedByServer(true);
    setStage({ k: 'grid' });
    void syncEngine.syncNow({ checkVersions: true }).finally(() => setLockedByServer(false));
  }, []);

  const goGrid = useCallback(() => {
    setStage({ k: 'grid' });
    void refreshKiosk();
  }, []);

  const startCamera = useCallback((emp: Employee, kind: Kind, ticket: { ticket: string; steps: AttendanceLivenessStep[] } | null, note: string | null) => {
    touch();
    setStage({ k: 'camera', emp, kind, ticket, steps: ticket ? ticket.steps : newDeviceChallenge(), note });
  }, [touch]);

  const chooseKind = useCallback(
    (emp: Employee, kind: Kind) => {
      touch();
      if (blocked) setStage({ k: 'grid' });
      // Online → the server checks the PIN (a locked subscription answers 403 there → paused, see onLocked). Only a
      // tablet that is offline skips it (the server flags PIN_NOT_CHECKED).
      else if (online) setStage({ k: 'pin', emp, kind });
      else startCamera(emp, kind, null, 'Offline — your PIN can’t be checked now. HR will review this punch.');
    },
    [blocked, online, startCamera, touch],
  );

  const save = useCallback(
    async (emp: Employee, kind: Kind, ticket: { ticket: string; steps: AttendanceLivenessStep[] } | null, steps: AttendanceLivenessStep[], outcome: LivenessOutcome) => {
      setStage({ k: 'saving', emp, kind });
      let saved: LocalPunch;
      try {
        saved = await recordPunch({
          employee: { user_id: emp.user_id, display_name: emp.display_name },
          kind,
          ticket,
          deviceSteps: steps,
          liveness: outcome.liveness,
          frames: outcome.frames,
        });
      } catch (e) {
        setStage({ k: 'done', emp, kind, headline: 'The punch could not be saved', detail: `${errorMessage(e)} Please try again or tell your manager.`, tone: 'warning' });
        return;
      }
      const after = (await uploadAndWait(saved.clientUuid, UPLOAD_WAIT_MS).catch(() => null)) ?? (await getPunch(saved.clientUuid).catch(() => null)) ?? saved;
      if (after.status === 'RECORDED' && after.result?.occurred_at) {
        setStage({ k: 'done', emp, kind, headline: punchMessage(kind, new Date(after.result.occurred_at), 'RECORDED'), detail: emp.display_name, tone: 'success' });
      } else if (after.status === 'REJECTED') {
        setStage({
          k: 'done',
          emp,
          kind,
          headline: punchMessage(kind, new Date(after.deviceTime), 'SAVED_ON_TABLET'),
          detail: `${emp.display_name} — the server didn't accept it (${after.result?.error ?? after.lastError ?? 'unknown reason'}). Please tell your manager.`,
          tone: 'warning',
        });
      } else {
        setStage({
          k: 'done',
          emp,
          kind,
          headline: punchMessage(kind, new Date(after.deviceTime), 'RECORDED'),
          detail: `${emp.display_name} — saved on this tablet. It will be sent at the next check-in.`,
          tone: 'success',
        });
      }
    },
    [],
  );

  const capture = kiosk?.capture ?? DEFAULT_CAPTURE;

  return (
    <View style={styles.root} onTouchStart={touch}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.overline}>Staff attendance</Text>
          <Text style={styles.title} numberOfLines={1}>
            {kiosk?.label || kiosk?.branch.name || 'Attendance'}
          </Text>
        </View>
        <Text style={styles.clock}>{clock}</Text>
        <View style={[styles.chip, online ? styles.chipOnline : styles.chipOffline]}>
          <Text style={[styles.chipText, online ? styles.chipTextOnline : styles.chipTextOffline]}>{online ? 'Online' : 'Offline'}</Text>
        </View>
        <Text style={[styles.unsent, unsent > 0 && styles.unsentWaiting]}>Unsent punches: {unsent}</Text>
        {rejected > 0 ? <Button title={`Not accepted: ${rejected}`} variant="danger" compact onPress={() => setShowRejected(true)} /> : null}
      </View>
      {uploadError && unsent > 0 ? <Banner kind="warning" message={uploadError} style={styles.flatBanner} /> : null}
      {blocked ? <Banner kind="danger" title="Attendance is paused" message={blocked} style={styles.flatBanner} /> : null}

      <View style={styles.body}>
        {stage.k === 'grid' ? <EmployeeGrid disabled={!!blocked} onPick={(emp) => { touch(); setStage({ k: 'kind', emp }); }} /> : null}

        {stage.k === 'kind' ? (
          <KindStep emp={stage.emp} online={online} onChoose={(kind) => chooseKind(stage.emp, kind)} onBack={goGrid} />
        ) : null}

        {stage.k === 'pin' ? (
          <PinStep
            emp={stage.emp}
            kind={stage.kind}
            onActivity={touch}
            onBack={() => setStage({ k: 'kind', emp: stage.emp })}
            onTicket={(t) => startCamera(stage.emp, stage.kind, { ticket: t.ticket, steps: t.challenge.steps }, null)}
            onOffline={() => startCamera(stage.emp, stage.kind, null, 'No connection — your PIN couldn’t be checked. HR will review this punch.')}
            onLocked={onLocked}
          />
        ) : null}

        {stage.k === 'camera' ? (
          <View style={styles.flex}>
            <Text style={styles.stepTitle}>
              {kindLabel(stage.kind)} · {stage.emp.display_name}
            </Text>
            {stage.note ? <Banner kind="warning" message={stage.note} style={styles.inlineBanner} /> : null}
            <LivenessCapture
              steps={stage.steps}
              capture={capture}
              onActivity={touch}
              onCancel={goGrid}
              onDone={(outcome) => void save(stage.emp, stage.kind, stage.ticket, stage.steps, outcome)}
            />
          </View>
        ) : null}

        {stage.k === 'saving' ? (
          <View style={styles.center}>
            <Text style={styles.big}>Saving {kindLabel(stage.kind).toLowerCase()}…</Text>
            <Text style={styles.muted}>{stage.emp.display_name}</Text>
          </View>
        ) : null}

        {stage.k === 'done' ? (
          <Pressable style={styles.center} onPress={goGrid} accessibilityRole="button" accessibilityLabel="Done — back to the list">
            <View style={[styles.doneMark, stage.tone === 'success' ? styles.doneMarkOk : styles.doneMarkWarn]}>
              <Text style={styles.doneMarkText}>{stage.tone === 'success' ? '✓' : '!'}</Text>
            </View>
            <Text style={styles.huge}>{stage.headline}</Text>
            {stage.detail ? <Text style={styles.doneDetail}>{stage.detail}</Text> : null}
            <Text style={styles.muted}>Tap to finish</Text>
          </Pressable>
        ) : null}
      </View>

      <RejectedSheet visible={showRejected} onClose={() => setShowRejected(false)} />
    </View>
  );
}

// ---- person grid ---------------------------------------------------------------------------------------------------

function EmployeeGrid({ onPick, disabled }: { onPick: (emp: Employee) => void; disabled: boolean }) {
  const styles = useStyles();
  const employees = useAttendanceKiosk((s) => s.employees);
  const [search, setSearch] = useState('');
  const [width, setWidth] = useState(0);
  const columns = Math.max(2, Math.floor((width || 600) / 190));
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? employees.filter((e) => e.display_name.toLowerCase().includes(q)) : employees;
  }, [employees, search]);

  return (
    <View style={styles.flex} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <View style={styles.gridTop}>
        <Text style={styles.stepTitle}>Tap your name</Text>
        <TextField placeholder="Search your name" value={search} onChangeText={setSearch} containerStyle={styles.search} autoCorrect={false} />
      </View>
      {employees.length === 0 ? (
        <Banner kind="info" message="No staff are listed for this branch yet. HR adds them in HR → Employees (reporting branch = this branch)." style={styles.inlineBanner} />
      ) : null}
      <FlatList
        key={columns}
        data={list}
        numColumns={columns}
        keyExtractor={(e) => String(e.user_id)}
        contentContainerStyle={styles.gridContent}
        columnWrapperStyle={styles.gridRow}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={notReady(item) ? `${item.display_name} — not set up` : item.display_name}
            accessibilityState={{ disabled: disabled || notReady(item) }}
            disabled={disabled || notReady(item)}
            onPress={() => onPick(item)}
            style={({ pressed }) => [
              styles.person,
              { width: `${100 / columns - 2}%` },
              pressed && styles.personPressed,
              (disabled || notReady(item)) && styles.personDisabled,
            ]}
          >
            <View style={styles.initials}>
              <Text style={styles.initialsText}>{item.initials}</Text>
            </View>
            <Text style={styles.personName} numberOfLines={2}>
              {item.display_name}
            </Text>
            {notReady(item) ? (
              <Text style={styles.personNotReady}>Ask HR: no {missingText(item.missing)}</Text>
            ) : (
              <Text style={styles.personHint}>{item.suggested_kind === 'OUT' ? 'At work' : ' '}</Text>
            )}
          </Pressable>
        )}
        ListEmptyComponent={employees.length > 0 ? <Text style={styles.muted}>No name matches “{search}”.</Text> : null}
      />
    </View>
  );
}

// ---- Time in / Time out ---------------------------------------------------------------------------------------------

function KindStep({ emp, online, onChoose, onBack }: { emp: Employee; online: boolean; onChoose: (k: Kind) => void; onBack: () => void }) {
  const styles = useStyles();
  const suggested = emp.suggested_kind;
  const other: Kind = suggested === 'IN' ? 'OUT' : 'IN';
  // Not set up (PIN and/or reference photo — readiness, known offline too from the cached list); online, a missing PIN.
  const unready = notReady(emp) || (online && !emp.pin_set);
  return (
    <View style={styles.center}>
      <View style={styles.initialsBig}>
        <Text style={styles.initialsBigText}>{emp.initials}</Text>
      </View>
      <Text style={styles.big}>{emp.display_name}</Text>
      {unready ? (
        <Banner
          kind="warning"
          title="Not set up for attendance yet"
          message={`Ask HR to add your ${missingText(emp.missing ?? (emp.pin_set ? [] : ['PIN']))}, then punch again.`}
          style={styles.inlineBanner}
        />
      ) : (
        <>
          <Pressable accessibilityRole="button" onPress={() => onChoose(suggested)} style={({ pressed }) => [styles.kindBig, pressed && styles.kindBigPressed]}>
            <Text style={styles.kindBigText}>{kindLabel(suggested)}</Text>
          </Pressable>
          <Button title={`${kindLabel(other)} instead`} variant="secondary" onPress={() => onChoose(other)} />
        </>
      )}
      <Button title="Not me — back" variant="ghost" onPress={onBack} />
    </View>
  );
}

// ---- PIN ------------------------------------------------------------------------------------------------------------

function PinStep({
  emp,
  kind,
  onActivity,
  onBack,
  onTicket,
  onOffline,
  onLocked,
}: {
  emp: Employee;
  kind: Kind;
  onActivity: () => void;
  onBack: () => void;
  onTicket: (t: { ticket: string; challenge: { steps: AttendanceLivenessStep[] } }) => void;
  /** A network failure (no answer at all) — the punch continues offline. */
  onOffline: () => void;
  /** 403 SUBSCRIPTION_LOCKED — no punch; the kiosk pauses. */
  onLocked: () => void;
}) {
  const styles = useStyles();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = await attendanceApi.pin({ user_id: emp.user_id, pin, kind });
      onTicket(t);
    } catch (e) {
      setPin('');
      // The subscription is LOCKED: punching stops (decision 4, docs/plans/attendance-pos-only.md) — never the offline path.
      if ((e as { code?: unknown } | null)?.code === 'SUBSCRIPTION_LOCKED') {
        onLocked();
        return;
      }
      // Only a genuine network failure (no answer — ApiError status 0) continues offline; any other answer is shown.
      if (apiStatus(e) === 0) {
        onOffline();
        return;
      }
      // Not set up (409 NOT_SET_UP — HR removed the PIN / reference photo since the list was read): say what's missing.
      if (apiStatus(e) === 409 && (e as { code?: unknown } | null)?.code === 'NOT_SET_UP') {
        void refreshKiosk({ force: true });
        setError(`Not set up for attendance yet — ask HR to add your ${missingText(emp.missing)}.`);
        return;
      }
      // Kiosk turned off / person no longer listed here: re-read the kiosk + list.
      if (apiStatus(e) === 403 || apiStatus(e) === 404) void refreshKiosk({ force: true });
      setError(errorMessage(e, 'The PIN could not be checked.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
      <Text style={styles.stepTitle}>
        {kindLabel(kind)} · {emp.display_name}
      </Text>
      <Text style={styles.muted}>Enter your attendance PIN</Text>
      {error ? <Banner kind="danger" message={error} style={styles.inlineBanner} /> : null}
      <PinPad
        value={pin}
        disabled={busy}
        onChange={(v) => {
          onActivity();
          setError(null);
          setPin(v);
        }}
      />
      <View style={styles.row}>
        <Button title="Back" variant="secondary" onPress={onBack} disabled={busy} />
        <Button title="OK" onPress={() => void submit()} disabled={pin.length < PIN_MIN} loading={busy} />
      </View>
    </ScrollView>
  );
}

// ---- punches the server refused -------------------------------------------------------------------------------------

function RejectedSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useStyles();
  const c = useThemeColors();
  const [items, setItems] = useState<LocalPunch[]>([]);
  useEffect(() => {
    if (visible) void rejectedPunches().then(setItems).catch(() => setItems([]));
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: c.backdrop }]}>
        <View style={styles.sheet}>
          <Text style={styles.stepTitle}>Punches not accepted by the server</Text>
          <Text style={styles.muted}>Kept on this tablet for a manager. HR can add a missing punch by hand (HR → Attendance).</Text>
          <ScrollView style={styles.sheetList}>
            {items.map((p) => (
              <View key={p.clientUuid} style={styles.rejectedRow}>
                <Text style={styles.personName}>
                  {kindLabel(p.kind)} · {p.displayName}
                </Text>
                <Text style={styles.muted}>{formatDateTime(p.deviceTime)}</Text>
                <Text style={styles.rejectedError}>{p.result?.error ?? p.lastError ?? '—'}</Text>
              </View>
            ))}
          </ScrollView>
          <Button title="Close" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: c.primaryTint,
    borderBottomWidth: 1,
    borderBottomColor: c.primaryTintBorder,
  },
  headerLeft: { flex: 1, minWidth: 200 },
  overline: { ...t.overline },
  title: { ...t.title },
  clock: { ...t.subtitle },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.pill },
  chipOnline: { backgroundColor: c.successSoft },
  chipOffline: { backgroundColor: c.warningSoft },
  chipText: { ...t.caption, fontFamily: t.bodyStrong.fontFamily },
  chipTextOnline: { color: c.success },
  chipTextOffline: { color: c.warning },
  unsent: { ...t.body, color: c.muted },
  unsentWaiting: { color: c.warning, fontFamily: t.bodyStrong.fontFamily },
  flatBanner: { borderRadius: 0 },
  body: { flex: 1 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md },
  stepTitle: { ...t.heading, color: c.primary, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
  big: { ...t.title, fontSize: 30, textAlign: 'center' },
  huge: { ...t.display, fontSize: 44, textAlign: 'center' },
  muted: { ...t.body, color: c.muted, textAlign: 'center' },
  inlineBanner: { marginHorizontal: spacing.xl, marginTop: spacing.md, alignSelf: 'stretch' },
  gridTop: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: spacing.lg, paddingRight: spacing.xl },
  search: { flex: 1, minWidth: 260, marginBottom: 0, marginLeft: spacing.xl },
  gridContent: { padding: spacing.xl, gap: spacing.md },
  gridRow: { gap: spacing.md },
  person: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 150,
  },
  personPressed: { backgroundColor: c.primarySoftStrong },
  initials: { width: 64, height: 64, borderRadius: 32, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  initialsText: { ...t.title, color: c.onPrimary },
  personName: { ...t.bodyStrong, textAlign: 'center' },
  personHint: { ...t.caption, color: c.success },
  personNotReady: { ...t.caption, color: c.warning, textAlign: 'center' },
  personDisabled: { opacity: 0.5 },
  initialsBig: { width: 112, height: 112, borderRadius: 56, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  initialsBigText: { ...t.display, fontSize: 44, color: c.onPrimary },
  kindBig: { minWidth: 360, paddingVertical: spacing.xl, borderRadius: radius.lg, backgroundColor: c.primary, alignItems: 'center' },
  kindBigPressed: { backgroundColor: c.primaryDark },
  kindBigText: { ...t.display, color: c.onPrimary },
  doneMark: { width: 120, height: 120, borderRadius: 60, alignItems: 'center', justifyContent: 'center' },
  doneMarkOk: { backgroundColor: c.success },
  doneMarkWarn: { backgroundColor: c.warning },
  doneMarkText: { ...t.display, fontSize: 64, color: '#ffffff' },
  doneDetail: { ...t.subtitle, textAlign: 'center', maxWidth: 720 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { backgroundColor: c.surface, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md, width: '100%', maxWidth: 720, maxHeight: '90%' },
  sheetList: { flexGrow: 0 },
  rejectedRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.xs },
  rejectedError: { ...t.body, color: c.danger },
}));
