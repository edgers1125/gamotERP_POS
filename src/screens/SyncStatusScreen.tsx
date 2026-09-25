// What the outbox is doing: online/offline, pending ops (and the oldest), last sync, last error, ops the server
// REJECTED (kept visible for a manager — never dropped), and the per-sale exceptions the server flagged for review
// when it recorded them (PRICE_MISMATCH, INVOICE_GAP, …) over the last few business days.
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SyncOp, SyncOpResult, SalePayload, VoidPayload } from '@pos-api/contract';
import { businessDate } from '@shared/business-day';

import type { RootStackParamList } from '../../App';
import { errorMessage, formatAge, formatDateTime, shiftDate } from '../components/shell/format';
import type { LocalSale } from '../contracts';
import { localStore } from '../db/localStore';
import { formatPeso } from '../sale/money';
import { syncEngine, useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Card, Screen } from '../ui/components';
import { colors, font, spacing } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'SyncStatus'>;

const EXCEPTION_DAYS = 7;

function describeOp(op: SyncOp): string {
  if (op.type === 'SALE') {
    const p = op.payload as SalePayload;
    return `Sale #${p.invoice_seq} · ${formatPeso(p.totals.grand_total)} · ${formatDateTime(p.sold_at)}`;
  }
  const v = op.payload as VoidPayload;
  return `Void · ${formatDateTime(v.voided_at)} · reason: ${v.reason}`;
}

export function SyncStatusScreen(_props: Props) {
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
      await syncEngine.syncNow();
    } catch (e) {
      setError(errorMessage(e, 'Sync failed.'));
    } finally {
      setSyncing(false);
      load();
    }
  };

  return (
    <Screen
      title="Sync status"
      refreshing={loading}
      onRefresh={load}
      actions={<Button title="Sync now" compact onPress={syncNow} loading={syncing || status.syncing} disabled={!status.online} />}
    >
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Card title="Outbox">
        <Line label="Connection" value={status.online ? 'Online' : 'Offline'} color={status.online ? colors.success : colors.warning} />
        <Line label="Waiting to sync" value={String(pending?.count ?? status.pending)} />
        <Line label="…of which offline sales" value={String(pending?.offlineSales ?? '—')} />
        <Line
          label="Oldest waiting"
          value={
            (pending?.oldestAt ?? status.oldestPendingAt)
              ? `${formatDateTime(pending?.oldestAt ?? status.oldestPendingAt)} (${formatAge(pending?.oldestAt ?? status.oldestPendingAt)})`
              : '—'
          }
        />
        <Line label="Last sync" value={status.lastSyncAt ? `${formatDateTime(status.lastSyncAt)} (${formatAge(status.lastSyncAt)})` : 'Never'} />
        <Line label="Last error" value={status.lastError ?? 'None'} color={status.lastError ? colors.danger : undefined} />
        {status.blockedReason ? <Banner kind="danger" title="Selling blocked" message={status.blockedReason} style={styles.gapTop} /> : null}
      </Card>

      <Card title={`Rejected by the server (${rejected.length})`}>
        {rejected.length === 0 ? (
          <Text style={styles.muted}>None.</Text>
        ) : (
          <>
            <Text style={styles.muted}>
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
      </Card>

      <Card title={`Flagged for review — last ${EXCEPTION_DAYS} days (${flagged.length})`}>
        {flagged.length === 0 ? (
          <Text style={styles.muted}>No sale was flagged.</Text>
        ) : (
          <>
            <Text style={styles.muted}>Recorded, but a manager must review these in POS Exceptions on the web.</Text>
            {flagged.map((s) => (
              <View key={s.client_uuid} style={styles.item}>
                <Text style={styles.itemTitle}>
                  {s.sync_result?.invoice_number ?? s.invoice_number} · {formatPeso(s.payload.totals.grand_total)} ·{' '}
                  {formatDateTime(s.payload.sold_at)}
                  {s.sync_result?.reference ? ` · ${s.sync_result.reference}` : ''}
                </Text>
                {(s.sync_result?.exceptions ?? []).map((x, i) => (
                  <Text key={i} style={styles.warnText}>
                    {x.kind}: {x.message}
                  </Text>
                ))}
                {s.voided?.sync_status === 'REJECTED' ? <Text style={styles.errorText}>The void of this sale was rejected.</Text> : null}
              </View>
            ))}
          </>
        )}
      </Card>
    </Screen>
  );
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { marginBottom: spacing.md },
  gapTop: { marginTop: spacing.md },
  line: { flexDirection: 'row', paddingVertical: spacing.xs },
  lineLabel: { width: 200, color: colors.muted, fontSize: font.body },
  lineValue: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: font.small, marginBottom: spacing.sm },
  item: { paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  itemTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  errorText: { color: colors.danger, fontSize: font.small },
  warnText: { color: colors.warning, fontSize: font.small },
  small: { color: colors.muted, fontSize: 11 },
});
