// Sales of one Manila business day on this terminal (default today): the device's own sales (from the local DB,
// incl. ones not yet synced) merged with the server's list when an online cashier session is available (which also
// brings in refunds and sales recorded before this device's local history). Void = same business day, offline OK;
// refund = an earlier business day, online only (→ RefundScreen).
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import type { PosSaleRow } from '@pos-api/contract';
import { businessDate } from '@shared/business-day';

import type { RootStackParamList } from '../../App';
import { cashierSession, useCashier } from '../auth/cashierSession';
import { errorMessage, formatTime, shiftDate } from '../components/shell/format';
import { VoidDialog } from '../components/shell/VoidDialog';
import type { LocalSale } from '../contracts';
import { api } from '../api/client';
import { localStore } from '../db/localStore';
import { formatPeso } from '../sale/money';
import { useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Screen } from '../ui/components';
import { makeStyles, useThemeColors, type ThemeColors } from '../ui/brandTheme';
import { fontFamily, radius, shadow, spacing } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'SalesToday'>;

interface Row {
  key: string;
  kind: 'SALE' | 'REFUND';
  invoice: string;
  total: string;
  soldAt: string;
  cashierName: string | null;
  local: LocalSale | null;
  server: PosSaleRow | null;
}

function mergeRows(local: LocalSale[], server: PosSaleRow[]): Row[] {
  const byUuid = new Map<string, PosSaleRow>();
  for (const r of server) if (r.client_uuid) byUuid.set(r.client_uuid, r);
  const seen = new Set<string>();
  const rows: Row[] = local.map((l) => {
    const s = byUuid.get(l.client_uuid) ?? null;
    if (s) seen.add(l.client_uuid);
    return {
      key: `l:${l.client_uuid}`,
      kind: 'SALE',
      invoice: s?.invoice_number ?? l.invoice_number,
      total: l.payload.totals.grand_total,
      soldAt: l.payload.sold_at,
      cashierName: s?.cashier.name ?? null,
      local: l,
      server: s,
    };
  });
  for (const s of server) {
    if (s.client_uuid && seen.has(s.client_uuid)) continue;
    rows.push({
      key: `s:${s.batch_id}`,
      kind: s.kind,
      invoice: s.invoice_number ?? s.reference,
      total: s.grand_total,
      soldAt: s.sold_at,
      cashierName: s.cashier.name,
      local: null,
      server: s,
    });
  }
  return rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : a.soldAt > b.soldAt ? -1 : 0));
}

type Tone = 'success' | 'warning' | 'danger' | 'info';

// Token names, resolved against the live brand colours in Pill.
const TONES: Record<Tone, { bg: keyof ThemeColors; fg: keyof ThemeColors }> = {
  success: { bg: 'successSoft', fg: 'success' },
  warning: { bg: 'warningSoft', fg: 'warning' },
  danger: { bg: 'dangerSoft', fg: 'danger' },
  info: { bg: 'infoSoft', fg: 'info' },
};

/** A small status badge (like MUI's small soft Chip). */
function Pill({ tone, text }: { tone: Tone; text: string }) {
  const styles = useStyles();
  const c = useThemeColors();
  const t = TONES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: c[t.bg] }]}>
      <Text style={[styles.pillText, { color: c[t.fg] }]} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

function syncLabel(row: Row): { text: string; tone: Tone } {
  if (row.local) {
    switch (row.local.sync_status) {
      case 'PENDING':
        return { text: 'Unsent', tone: 'warning' };
      case 'REJECTED':
        return { text: 'Rejected by server', tone: 'danger' };
      default: {
        const n = row.local.sync_result?.exceptions.length ?? 0;
        return n > 0 ? { text: `Checked in · ${n} for review`, tone: 'warning' } : { text: 'Checked in', tone: 'success' };
      }
    }
  }
  return { text: 'Recorded', tone: 'success' };
}

export function SalesTodayScreen({ navigation }: Props) {
  const styles = useStyles();
  const online = useSyncStatus((s) => s.online);
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt);
  const cashier = useCashier((s) => s.cashier);
  const today = businessDate(new Date());
  const [date, setDate] = useState(today);
  const [local, setLocal] = useState<LocalSale[]>([]);
  const [server, setServer] = useState<PosSaleRow[]>([]);
  const [serverNote, setServerNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [voidTarget, setVoidTarget] = useState<LocalSale | null>(null);
  const loadId = useRef(0);

  const load = useCallback(async () => {
    const id = ++loadId.current;
    setLoading(true);
    setError(null);
    try {
      const l = await localStore.listSales(date);
      let s: PosSaleRow[] = [];
      let note: string | null = null;
      if (!online) note = 'Offline — showing only the sales saved on this device.';
      else if (!cashierSession.isOnlineSession()) note = 'Signed in with a PIN — showing only the sales saved on this device.';
      else {
        try {
          s = await api.sales(date);
        } catch (e) {
          note = `Could not load the server's list: ${errorMessage(e)}`;
        }
      }
      if (id !== loadId.current) return;
      setLocal(l);
      setServer(s);
      setServerNote(note);
    } catch (e) {
      if (id === loadId.current) setError(errorMessage(e, 'Could not read the sales on this device.'));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [date, online]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  // Statuses change as the outbox syncs.
  useEffect(() => {
    if (lastSyncAt) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSyncAt]);

  const rows = useMemo(() => mergeRows(local, server), [local, server]);
  const totals = useMemo(() => {
    let sales = 0;
    let count = 0;
    for (const r of rows) {
      const voided = !!r.local?.voided || !!r.server?.voided;
      if (voided) continue;
      sales += Number(r.total) || 0;
      if (r.kind === 'SALE') count++;
    }
    return { sales, count };
  }, [rows]);

  const renderRow = (row: Row) => {
    const voided = !!row.local?.voided || !!row.server?.voided;
    const refunded = !!row.local?.refunded || !!row.server?.refunded;
    const saleDay = businessDate(new Date(row.soldAt));
    const sameDay = saleDay === today;
    const canVoid =
      row.kind === 'SALE' && !!row.local && !voided && !refunded && sameDay && row.local.sync_status !== 'REJECTED' && !!cashier;
    const canOfferRefund = row.kind === 'SALE' && !voided && !refunded && saleDay < today;
    const sync = syncLabel(row);
    const voidStatus = row.local?.voided?.sync_status;
    return (
      <View key={row.key} style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.invoice}>
            {row.kind === 'REFUND' ? 'Refund ' : ''}
            {row.invoice}
          </Text>
          <Text style={styles.meta}>
            {formatTime(row.soldAt)}
            {row.cashierName ? ` · ${row.cashierName}` : ''}
            {row.server?.status === 'OVERSOLD' ? ' · Oversold' : ''}
          </Text>
          {row.local?.sync_status === 'REJECTED' && row.local.sync_result?.error ? (
            <Text style={styles.errorText}>{row.local.sync_result.error}</Text>
          ) : null}
        </View>
        <Text style={[styles.total, styles.totalCol, voided && styles.struck]}>{formatPeso(row.total)}</Text>
        <View style={styles.statusCol}>
          <Pill tone={sync.tone} text={sync.text} />
          {voided ? (
            <Pill
              tone="danger"
              text={`Voided${voidStatus === 'PENDING' ? ' (unsent)' : voidStatus === 'REJECTED' ? ' (void rejected)' : ''}`}
            />
          ) : null}
          {refunded ? <Pill tone="warning" text="Refunded" /> : null}
        </View>
        <View style={styles.actionCol}>
          {row.local ? (
            <Button
              title="Receipt"
              variant="ghost"
              compact
              onPress={() => navigation.navigate('Receipt', { clientUuid: row.local!.client_uuid, reprint: true })}
            />
          ) : null}
          {canVoid ? <Button title="Void" variant="danger" compact onPress={() => setVoidTarget(row.local)} /> : null}
          {canOfferRefund ? (
            <Button
              title="Refund"
              variant="secondary"
              compact
              disabled={!online}
              onPress={() =>
                navigation.navigate('Refund', {
                  batchId: row.server?.batch_id,
                  invoiceNumber: row.server?.invoice_number ?? row.local?.invoice_number ?? undefined,
                  saleClientUuid: row.local?.client_uuid ?? row.server?.client_uuid ?? undefined,
                })
              }
            />
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <Screen
      title={date === today ? 'Sales today' : `Sales on ${date}`}
      refreshing={loading}
      onRefresh={load}
      actions={
        <>
          <Button title="◀" compact variant="secondary" onPress={() => setDate(shiftDate(date, -1))} accessibilityLabel="Previous day" />
          <Button title="Today" compact variant="secondary" disabled={date === today} onPress={() => setDate(today)} />
          <Button
            title="▶"
            compact
            variant="secondary"
            disabled={date >= today}
            onPress={() => setDate(shiftDate(date, 1))}
            accessibilityLabel="Next day"
          />
          <Button title="Refund a sale" compact variant="primary" disabled={!online} onPress={() => navigation.navigate('Refund', {})} />
        </>
      }
    >
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      {serverNote ? <Banner kind="info" message={serverNote} style={styles.gap} /> : null}
      {date < today ? (
        <Banner
          kind="info"
          message={online ? 'Sales from an earlier day can no longer be voided — refund them instead.' : 'Refunds need a connection.'}
          style={styles.gap}
        />
      ) : null}
      <View style={styles.table}>
        <View style={styles.tableTitleRow}>
          <Text style={styles.tableTitle}>{`${totals.count} sale(s) · net ${formatPeso(totals.sales)}`}</Text>
        </View>
        <View style={styles.headRow}>
          <Text style={[styles.headCell, styles.rowMain]}>Invoice</Text>
          <Text style={[styles.headCell, styles.totalCol]}>Total</Text>
          <Text style={[styles.headCell, styles.statusCol]}>Status</Text>
          <View style={styles.actionCol} />
        </View>
        {rows.length === 0 ? <Text style={styles.empty}>{loading ? 'Loading…' : 'No sales on this day.'}</Text> : rows.map(renderRow)}
      </View>
      <VoidDialog
        sale={voidTarget}
        onClose={() => setVoidTarget(null)}
        onVoided={() => {
          setVoidTarget(null);
          load();
        }}
      />
    </Screen>
  );
}

const useStyles = makeStyles((c, t) => ({
  gap: { marginBottom: spacing.md },
  // Table (like MUI Paper + Table): white surface, 1px border, muted header row, 1px row dividers.
  table: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    marginBottom: spacing.md,
    ...shadow.card,
  },
  tableTitleRow: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  tableTitle: { ...t.heading },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: c.surfaceMuted,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  headCell: { ...t.overline },
  empty: {
    ...t.body,
    color: c.muted,
    paddingVertical: spacing.xl,
    textAlign: 'center',
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: spacing.md,
  },
  rowMain: { flex: 3 },
  invoice: { ...t.bodyStrong },
  meta: { ...t.caption, marginTop: 2 },
  errorText: { ...t.caption, color: c.danger, marginTop: 2 },
  totalCol: { flex: 1.3, textAlign: 'right' },
  total: { ...t.money },
  struck: { textDecorationLine: 'line-through', color: c.muted },
  statusCol: { flex: 2, alignItems: 'flex-start', gap: spacing.xs },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: spacing.sm + 2 },
  pillText: { ...t.caption, fontFamily: fontFamily.medium },
  actionCol: { flex: 2.2, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm },
}));
