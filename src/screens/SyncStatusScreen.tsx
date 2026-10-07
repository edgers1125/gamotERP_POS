// The Check-in screen: online/offline, unsent ops (and the oldest), last check-in, last error, the license lease, ops the server
// REJECTED (kept visible for a manager — never dropped), and the per-sale exceptions the server flagged for review
// when it recorded them (PRICE_MISMATCH, INVOICE_GAP, …) over the last few business days.
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import type {
  DrawerClosePayload,
  DrawerMovementPayload,
  DrawerOpenPayload,
  SyncOp,
  SyncOpResult,
  SalePayload,
  VoidPayload,
} from '@pos-api/contract';
import { businessDate } from '@shared/business-day';

import type { RootStackParamList } from '../../App';
import { errorMessage, formatAge, formatDateTime, shiftDate } from '../components/shell/format';
import type { LocalSale } from '../contracts';
import type { LicenseCode } from '../license/lease';
import { localStore } from '../db/localStore';
import { formatPeso } from '../sale/money';
import { syncEngine, useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Screen } from '../ui/components';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { fontFamily, radius, shadow, spacing } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'SyncStatus'>;

const EXCEPTION_DAYS = 7;

function describeOp(op: SyncOp): string {
  if (op.type === 'SALE') {
    const p = op.payload as SalePayload;
    return `Sale #${p.invoice_seq} · ${formatPeso(p.totals.grand_total)} · ${formatDateTime(p.sold_at)}`;
  }
  if (op.type === 'DRAWER_OPEN') {
    const d = op.payload as DrawerOpenPayload;
    return `Cash drawer opened · float ${formatPeso(d.opening_float)} · ${formatDateTime(d.opened_at)}`;
  }
  if (op.type === 'DRAWER_MOVEMENT') {
    const d = op.payload as DrawerMovementPayload;
    return `${d.kind === 'CASH_IN' ? 'Cash in' : 'Cash out'} · ${formatPeso(d.amount)} · ${formatDateTime(d.occurred_at)} · ${d.reason}`;
  }
  if (op.type === 'DRAWER_CLOSE') {
    const d = op.payload as DrawerClosePayload;
    return `Cash drawer closed · counted ${formatPeso(d.counted_cash)} · ${formatDateTime(d.closed_at)}`;
  }
  const v = op.payload as VoidPayload;
  return `Void · ${formatDateTime(v.voided_at)} · reason: ${v.reason}`;
}

function licenseLabel(code: LicenseCode | null, state: 'OK' | 'OVERDUE' | null): string {
  if (code === 'LOCKED') return 'Subscription locked';
  if (code === 'EXPIRED') return 'Expired';
  if (code === 'VALID') return state === 'OVERDUE' ? 'Valid — payment overdue' : 'Valid';
  if (code === 'NO_KEYS') return 'Not checked (no license key in this build)';
  if (code === 'NOT_ENFORCED') return 'Not enforced yet';
  return '—';
}

export function SyncStatusScreen(_props: Props) {
  const styles = useStyles();
  const c = useThemeColors();
  const status = useSyncStatus();
  const [pending, setPending] = useState<{ count: number; oldestAt: string | null; offlineSales: number } | null>(null);
  const [rejected, setRejected] = useState<{ op: SyncOp; result: SyncOpResult }[]>([]);
  const [flagged, setFlagged] = useState<LocalSale[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([localStore.pendingCount(), localStore.rejectedOps()]);
      const today = businessDate(new Date());
      const days = Array.from({ length: EXCEPTION_DAYS }, (_, i) => shiftDate(today, -i));
      const perDay = await Promise.all(days.map((d) => localStore.listSales(d)));
      const withIssues = perDay
        .flat()
        .filter((s) => (s.sync_result?.exceptions.length ?? 0) > 0 || s.voided?.sync_status === 'REJECTED')
        .sort((a, b) => (a.payload.sold_at < b.payload.sold_at ? 1 : -1));
      setPending(p);
      setRejected(r);
      setFlagged(withIssues);
    } catch (e) {
      setError(errorMessage(e, 'Could not read the outbox.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  useEffect(() => {
    load();
  }, [status.lastSyncAt, status.pending, load]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await syncEngine.syncNow({ checkVersions: true });
    } catch (e) {
      setError(errorMessage(e, 'Check-in failed.'));
    } finally {
      setSyncing(false);
      load();
    }
  };

  return (
    <Screen
      title="Check-in"
      refreshing={loading}
      onRefresh={load}
      actions={<Button title="Check in now" compact onPress={syncNow} loading={syncing || status.syncing} disabled={!status.online} />}
    >
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Group title="Check-in">
        <Line label="Connection" value={status.online ? 'Online' : 'Offline'} color={status.online ? c.success : c.warning} />
        <Line
          label="Live updates"
          value={
            status.realtime === 'connected'
              ? 'Connected'
              : status.realtime === 'reconnecting'
                ? 'Reconnecting (polling meanwhile)'
                : 'Off (polling)'
          }
          color={status.realtime === 'connected' ? c.success : c.warning}
        />
        <Line label="Unsent" value={String(pending?.count ?? status.pending)} />
        <Line label="…of which offline sales" value={String(pending?.offlineSales ?? '—')} />
        <Line
          label="Oldest waiting"
          value={
            (pending?.oldestAt ?? status.oldestPendingAt)
              ? `${formatDateTime(pending?.oldestAt ?? status.oldestPendingAt)} (${formatAge(pending?.oldestAt ?? status.oldestPendingAt)})`
              : '—'
          }
        />
        <Line label="Last check-in" value={status.lastSyncAt ? `${formatDateTime(status.lastSyncAt)} (${formatAge(status.lastSyncAt)})` : 'Never'} />
        <Line label="Last error" value={status.lastError ?? 'None'} color={status.lastError ? c.danger : undefined} />
        {status.blockedReason ? (
          <View style={styles.groupBanner}>
            <Banner kind="danger" title="Selling blocked" message={status.blockedReason} />
          </View>
        ) : null}
      </Group>

      <Group title="License">
        <Line
          label="State"
          value={licenseLabel(status.license?.code ?? null, status.license?.state ?? null)}
          color={status.license?.code === 'LOCKED' || status.license?.code === 'EXPIRED' ? c.danger : status.license?.state === 'OVERDUE' ? c.warning : undefined}
        />
        <Line label="Valid until" value={status.license?.validUntil ? formatDateTime(status.license.validUntil) : '—'} />
        {status.license?.detail ? <Line label="Detail" value={status.license.detail} /> : null}
        {status.licenseWarning ? (
          <View style={styles.groupBanner}>
            <Banner kind="warning" title="License" message={status.licenseWarning} />
          </View>
        ) : null}
      </Group>

      <Group title={`Rejected by the server (${rejected.length})`}>
        {rejected.length === 0 ? (
          <Text style={styles.note}>None.</Text>
        ) : (
          <>
            <Text style={styles.note}>
              These could not be recorded at all. They stay on this device — show them to a manager; nothing is deleted.
            </Text>
            {rejected.map(({ op, result }) => (
              <View key={op.client_uuid} style={styles.item}>
                <Text style={styles.itemTitle}>{describeOp(op)}</Text>
                <Text style={styles.errorText}>{result.error ?? 'Rejected'}</Text>
                <Text style={styles.small}>Op {op.client_uuid}</Text>
              </View>
            ))}
          </>
        )}
      </Group>

      <Group title={`Flagged for review — last ${EXCEPTION_DAYS} days (${flagged.length})`}>
        {flagged.length === 0 ? (
          <Text style={styles.note}>No sale was flagged.</Text>
        ) : (
          <>
            <Text style={styles.note}>Recorded, but a manager must review these in POS Exceptions on the web.</Text>
            {flagged.map((s) => (
              <View key={s.client_uuid} style={styles.item}>
                <Text style={styles.itemTitle}>
                  {s.sync_result?.invoice_number ?? s.invoice_number} · {formatPeso(s.payload.totals.grand_total)} ·{' '}
                  {formatDateTime(s.payload.sold_at)}
                  {s.sync_result?.reference ? ` · ${s.sync_result.reference}` : ''}
                </Text>
                {(s.sync_result?.exceptions ?? []).map((x, i) => (
                  <View key={i} style={styles.exception}>
                    <View style={[styles.pill, styles.pillWarning]}>
                      <Text style={[styles.pillText, styles.pillTextWarning]}>{x.kind}</Text>
                    </View>
                    <Text style={styles.exceptionText}>{x.message}</Text>
                  </View>
                ))}
                {s.voided?.sync_status === 'REJECTED' ? <Text style={styles.errorText}>The void of this sale was rejected.</Text> : null}
              </View>
            ))}
          </>
        )}
      </Group>
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
      <Text style={[styles.lineValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  gap: { marginBottom: spacing.md },
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
  groupBanner: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  lineLabel: { ...t.label, width: 200 },
  lineValue: { ...t.body, flex: 1, textAlign: 'right' },
  note: { ...t.caption, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  item: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: spacing.xs,
  },
  itemTitle: { ...t.bodyStrong },
  errorText: { ...t.caption, color: c.danger },
  small: { ...t.caption },
  exception: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  exceptionText: { ...t.caption, color: c.text, flex: 1, paddingTop: 2 },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: spacing.sm + 2 },
  pillWarning: { backgroundColor: c.warningSoft },
  pillText: { ...t.caption, fontFamily: fontFamily.medium },
  pillTextWarning: { color: c.warning },
}));
