// Device facts (server, device id, attestation level, terminal, app version), manual Sync now / Refresh catalog, the
// cashier's offline PIN, and — only once the server has REVOKED this device — "Re-enroll", which clears the
// enrollment and returns to the enrollment screen (the shell does the clearing: see App.tsx).
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Text, View } from 'react-native';

import type { PosBootstrap, PosCounters } from '@pos-api/contract';

import type { RootStackParamList } from '../../App';
import { isAttendanceOnlyTerminal, unsentPunchCount } from '../attendance/attendanceKiosk';
import { cashierSession, useCashier } from '../auth/cashierSession';
import { errorMessage, formatDateTime } from '../components/shell/format';
import { appBuildNumber, appVersionName } from '../config/runtime';
import { serverConfig } from '../config/serverConfig';
import type { EnrollmentState } from '../contracts';
import { localStore } from '../db/localStore';
import { syncEngine, useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Screen } from '../ui/components';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'> & {
  /** Provided by the shell: clears the enrollment and shows the enrollment screen. */
  onReEnroll: () => Promise<void>;
};

function displayVersion(): string {
  const v = appVersionName();
  const build = appBuildNumber();
  return build ? `${v} (${build})` : v;
}

export function SettingsScreen({ onReEnroll }: Props) {
  const styles = useStyles();
  const c = useThemeColors();
  const status = useSyncStatus();
  const cashier = useCashier((s) => s.cashier);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(null);
  const [counters, setCounters] = useState<PosCounters | null>(null);
  const [catalogInfo, setCatalogInfo] = useState<{ version: string; generated_at: string; items: number } | null>(null);
  const [busy, setBusy] = useState<'sync' | 'catalog' | 'reenroll' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [url, e, b, c, cat] = await Promise.all([
      serverConfig.getBaseUrl().catch(() => null),
      localStore.getEnrollment().catch(() => null),
      localStore.getBootstrap().catch(() => null),
      localStore.getCounters().catch(() => null),
      localStore.getCatalog().catch(() => null),
    ]);
    setBaseUrl(url);
    setEnrollment(e);
    setBootstrap(b);
    setCounters(c);
    setCatalogInfo(cat ? { version: cat.version, generated_at: cat.generated_at, items: cat.items.length } : null);
  }, []);

  useEffect(() => {
    load();
  }, [load, status.lastSyncAt]);

  const run = async (kind: 'sync' | 'catalog') => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === 'sync') await syncEngine.syncNow({ checkVersions: true });
      else await syncEngine.refreshCatalog(true);
      setMessage({ kind: 'success', text: kind === 'sync' ? 'Check-in finished.' : 'Catalog refreshed.' });
    } catch (e) {
      setMessage({ kind: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(null);
      load();
    }
  };

  const confirmReEnroll = async () => {
    const pending = status.pending;
    // Unsent attendance punches are kept too, but they were signed by this (revoked) enrollment's key — say so.
    const punches = await unsentPunchCount().catch(() => 0);
    Alert.alert(
      'Re-enroll this device?',
      'The enrollment, cached catalog, approver lists and offline PINs are cleared; you will need a new enrollment code from the Enroll POS page. ' +
        (pending > 0
          ? `The ${pending} unsent operation(s) stay on this device and are sent after re-enrollment — any the server can't accept will show as rejected for a manager.`
          : 'Sales already on this device are kept.') +
        (punches > 0
          ? ` ${punches} unsent attendance punch${punches === 1 ? '' : 'es'} also stay on this tablet with their photos, but the server can't accept punches signed before re-enrolling — they will be listed as "Not accepted" on the Attendance screen. Ask HR to enter those times by hand.`
          : ''),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Re-enroll',
          style: 'destructive',
          onPress: async () => {
            setBusy('reenroll');
            try {
              await onReEnroll();
            } catch (e) {
              setMessage({ kind: 'danger', text: errorMessage(e, 'Could not clear the enrollment.') });
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  const terminal = bootstrap?.terminal ?? enrollment?.terminal ?? null;
  const onlineSession = cashier?.mode === 'ONLINE' && cashierSession.isOnlineSession();
  // An attendance-only tablet (docs/plans/attendance-pos-only.md): no catalog, invoice numbers, BIR details or cashier.
  const attendanceOnly = isAttendanceOnlyTerminal(terminal);

  return (
    <Screen title="Settings">
      {message ? <Banner kind={message.kind} message={message.text} style={styles.gap} /> : null}
      {status.revoked ? (
        <Banner
          kind="danger"
          title="This device was revoked"
          message="It can no longer sell or check in. Enroll it again with a new code from the Enroll POS page."
          actionLabel="Re-enroll"
          onAction={() => void confirmReEnroll()}
          style={styles.gap}
        />
      ) : null}

      <View style={styles.columns}>
        <View style={styles.column}>
          <Group title="Device">
            <Line label="Server" value={baseUrl ?? '—'} />
            <Line label="Device id" value={enrollment ? String(enrollment.device_id) : '—'} />
            <Line label="Attestation" value={bootstrap?.device.attestation_level ?? '—'} />
            <Line label="Enrolled" value={formatDateTime(bootstrap?.device.enrolled_at ?? enrollment?.enrolled_at)} />
            <Line label="App version" value={displayVersion()} />
            {status.updateRequired ? (
              <Line label="Required version" value={`${status.updateRequired} or newer`} color={c.danger} />
            ) : null}
          </Group>
          <Group title="Data">
            {attendanceOnly ? (
              <Line label="Type" value="Attendance only — punches, no selling" />
            ) : (
              <>
                <Line label="Catalog" value={catalogInfo ? `${catalogInfo.items} items · ${catalogInfo.version.slice(0, 12)}` : 'Not loaded'} />
                <Line label="Catalog built" value={formatDateTime(catalogInfo?.generated_at)} />
                <Line label="Next sale no." value={counters ? String(counters.next_invoice_number) : '—'} />
                <Line label="Next return no." value={counters ? String(counters.next_return_number) : '—'} />
              </>
            )}
            <Line label="Last check-in" value={formatDateTime(status.lastSyncAt)} />
            <View style={styles.buttons}>
              <Button title="Check in now" onPress={() => run('sync')} loading={busy === 'sync'} disabled={!status.online || busy !== null} style={styles.flex} />
              {attendanceOnly ? null : (
                <Button
                  title="Refresh catalog"
                  variant="secondary"
                  onPress={() => run('catalog')}
                  loading={busy === 'catalog'}
                  disabled={!status.online || busy !== null}
                  style={styles.flex}
                />
              )}
            </View>
          </Group>
        </View>
        <View style={styles.column}>
          <Group title="Terminal">
            {terminal ? (
              <>
                <Line label="Terminal" value={`${terminal.name} (${terminal.code})`} />
                <Line label="Branch" value={terminal.branch.name + (terminal.branch.branch_code ? ` (${terminal.branch.branch_code})` : '')} />
                <Line label="Company" value={terminal.company.name} />
                {attendanceOnly ? null : (
                  <>
                    <Line label="Invoice prefix" value={terminal.invoice_prefix} />
                    <Line label="MIN" value={terminal.bir.min ?? '—'} />
                    <Line label="Serial no." value={terminal.bir.serial_number ?? '—'} />
                    <Line label="PTU" value={terminal.bir.ptu_number ?? '—'} />
                  </>
                )}
                <Line
                  label="Offline limit"
                  value={terminal.offline_unlimited === true ? 'None' : `${terminal.offline_max_hours} h / ${terminal.offline_max_sales} sales`}
                />
              </>
            ) : (
              <Text style={styles.note}>Not enrolled.</Text>
            )}
          </Group>
          {attendanceOnly ? null : (
          <Group title="Cashier">
            <Line label="Signed in" value={cashier ? `${cashier.name} (${cashier.mode === 'ONLINE' ? 'password' : 'PIN'})` : '—'} />
            <View style={styles.buttons}>
              <Button
                title="Change offline PIN"
                variant="secondary"
                disabled={!onlineSession}
                onPress={() => cashierSession.requestPinChange()}
                style={styles.flex}
              />
              <Button title="Sign out" variant="secondary" onPress={() => cashierSession.logout()} style={styles.flex} />
            </View>
            {!onlineSession ? <Text style={styles.footnote}>Sign in with your password to change your PIN.</Text> : null}
          </Group>
          )}
          {status.revoked ? (
            <Button title="Re-enroll this device" variant="danger" onPress={() => void confirmReEnroll()} loading={busy === 'reenroll'} />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

/** A settings-style group: white card, overline section title, rows separated by 1px dividers. */
function Group({ title, children }: { title: string; children?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, color ? { color } : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  gap: { marginBottom: spacing.md },
  columns: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  column: { flex: 1, minWidth: 320 },
  group: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    ...shadow.card,
  },
  groupTitle: { ...t.overline, paddingTop: spacing.lg, paddingBottom: spacing.sm, paddingHorizontal: spacing.lg },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  lineLabel: { ...t.label, width: 150 },
  lineValue: { ...t.body, flex: 1, textAlign: 'right' },
  note: { ...t.caption, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  footnote: { ...t.caption, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, marginTop: -spacing.sm },
  buttons: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  flex: { flex: 1 },
}));
