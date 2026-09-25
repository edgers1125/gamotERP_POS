// Device facts (server, device id, attestation level, terminal, app version), manual Sync now / Refresh catalog, the
// cashier's offline PIN, and — only once the server has REVOKED this device — "Re-enroll", which clears the
// enrollment and returns to the enrollment screen (the shell does the clearing: see App.tsx).
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import type { PosBootstrap, PosCounters } from '@pos-api/contract';

import type { RootStackParamList } from '../../App';
import { cashierSession, useCashier } from '../auth/cashierSession';
import { errorMessage, formatDateTime } from '../components/shell/format';
import { appBuildNumber, appVersionName } from '../config/runtime';
import { serverConfig } from '../config/serverConfig';
import type { EnrollmentState } from '../contracts';
import { localStore } from '../db/localStore';
import { syncEngine, useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Card, Screen } from '../ui/components';
import { colors, font, spacing } from '../ui/theme';

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
      if (kind === 'sync') await syncEngine.syncNow();
      else await syncEngine.refreshCatalog(true);
      setMessage({ kind: 'success', text: kind === 'sync' ? 'Sync finished.' : 'Catalog refreshed.' });
    } catch (e) {
      setMessage({ kind: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(null);
      load();
    }
  };

  const confirmReEnroll = () => {
    const pending = status.pending;
    Alert.alert(
      'Re-enroll this device?',
      'The enrollment, cached catalog, approver lists and offline PINs are cleared; you will need a new enrollment code from the Enroll POS page. ' +
        (pending > 0
          ? `The ${pending} unsynced operation(s) stay on this device and are sent after re-enrollment — any the server can't accept will show as rejected for a manager.`
          : 'Sales already on this device are kept.'),
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

  return (
    <Screen title="Settings">
      {message ? <Banner kind={message.kind} message={message.text} style={styles.gap} /> : null}
      {status.revoked ? (
        <Banner
          kind="danger"
          title="This device was revoked"
          message="It can no longer sell or sync. Enroll it again with a new code from the Enroll POS page."
          actionLabel="Re-enroll"
          onAction={confirmReEnroll}
          style={styles.gap}
        />
      ) : null}

      <View style={styles.columns}>
        <View style={styles.column}>
          <Card title="Device">
            <Line label="Server" value={baseUrl ?? '—'} />
            <Line label="Device id" value={enrollment ? String(enrollment.device_id) : '—'} />
            <Line label="Attestation" value={bootstrap?.device.attestation_level ?? '—'} />
            <Line label="Enrolled" value={formatDateTime(bootstrap?.device.enrolled_at ?? enrollment?.enrolled_at)} />
            <Line label="App version" value={displayVersion()} />
            {status.updateRequired ? (
              <Line label="Required version" value={`${status.updateRequired} or newer`} color={colors.danger} />
            ) : null}
          </Card>
          <Card title="Data">
            <Line label="Catalog" value={catalogInfo ? `${catalogInfo.items} items · ${catalogInfo.version.slice(0, 12)}` : 'Not loaded'} />
            <Line label="Catalog built" value={formatDateTime(catalogInfo?.generated_at)} />
            <Line label="Next sale no." value={counters ? String(counters.next_invoice_number) : '—'} />
            <Line label="Next return no." value={counters ? String(counters.next_return_number) : '—'} />
            <Line label="Last sync" value={formatDateTime(status.lastSyncAt)} />
            <View style={styles.buttons}>
              <Button title="Sync now" onPress={() => run('sync')} loading={busy === 'sync'} disabled={!status.online || busy !== null} style={styles.flex} />
              <Button
                title="Refresh catalog"
                variant="secondary"
                onPress={() => run('catalog')}
                loading={busy === 'catalog'}
                disabled={!status.online || busy !== null}
                style={styles.flex}
              />
            </View>
          </Card>
        </View>
        <View style={styles.column}>
          <Card title="Terminal">
            {terminal ? (
              <>
                <Line label="Terminal" value={`${terminal.name} (${terminal.code})`} />
                <Line label="Branch" value={terminal.branch.name + (terminal.branch.branch_code ? ` (${terminal.branch.branch_code})` : '')} />
                <Line label="Company" value={terminal.company.name} />
                <Line label="Invoice prefix" value={terminal.invoice_prefix} />
                <Line label="MIN" value={terminal.bir.min ?? '—'} />
                <Line label="Serial no." value={terminal.bir.serial_number ?? '—'} />
                <Line label="PTU" value={terminal.bir.ptu_number ?? '—'} />
                <Line label="Offline limit" value={`${terminal.offline_max_hours} h / ${terminal.offline_max_sales} sales`} />
              </>
            ) : (
              <Text style={styles.muted}>Not enrolled.</Text>
            )}
          </Card>
          <Card title="Cashier">
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
            {!onlineSession ? <Text style={styles.muted}>Sign in with your password to change your PIN.</Text> : null}
          </Card>
          {status.revoked ? (
            <Button title="Re-enroll this device" variant="danger" onPress={confirmReEnroll} loading={busy === 'reenroll'} />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, color ? { color } : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { marginBottom: spacing.md },
  columns: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  column: { flex: 1, minWidth: 320 },
  line: { flexDirection: 'row', paddingVertical: spacing.xs },
  lineLabel: { width: 150, color: colors.muted, fontSize: font.body },
  lineValue: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: font.small, marginTop: spacing.sm },
  buttons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  flex: { flex: 1 },
});
