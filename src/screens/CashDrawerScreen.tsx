// Cash drawer (top-bar section; GamotERP docs/plans/sales-side-tables-and-cash-drawer.md §B, CLAUDE.md "Cash drawer").
// The ONLY place drawer data is entered — the web shows a read-only tally. One session per terminal: open with an
// opening float → cash in / cash out (amount + reason) → close with a BLIND count (the expected cash and the over/short
// appear only after the count is saved). Every step is saved locally and queued as a signed DRAWER_* op, so it all
// works offline. Selling is blocked while no drawer is open (useDrawerGate).
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import type { DrawerMovementKind } from '@pos-api/contract';
import { businessDate } from '@shared/business-day';

import type { RootStackParamList } from '../../App';
import { useCashier } from '../auth/cashierSession';
import {
  DenominationCounter,
  denominationAmountText,
  denominationSummary,
  hasDenominationCounts,
  type DenominationCounts,
} from '../components/sale/DenominationCounter';
import { Chip, Sheet, StatusBadge, SummaryRow, type BadgeTone } from '../components/sale/ui';
import { errorMessage, formatDateTime, formatTime } from '../components/shell/format';
import { onLocalStoreEvent } from '../db/events';
import { localStore } from '../db/localStore';
import {
  DRAWER_NOTE_MAX,
  DRAWER_REASON_MAX,
  varianceOf,
  type DrawerSyncState,
  type DrawerTally,
  type LocalDrawerMovement,
  type LocalDrawerSession,
} from '../drawer/cashDrawer';
import { useCashDrawer, useCashDrawerSync } from '../drawer/useCashDrawer';
import { cleanDecimalInput, formatPeso, isMoneyText } from '../sale/money';
import { syncEngine } from '../sync/syncEngine';
import { Banner, Button, Card, Screen, TextField } from '../ui/components';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { radius, spacing } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'CashDrawer'>;

const QUICK_FLOATS = [0, 500, 1000, 2000, 5000];

function syncBadge(state: DrawerSyncState | null): { label: string; tone: BadgeTone } | null {
  if (state === 'PENDING') return { label: 'Unsent', tone: 'warning' };
  if (state === 'REJECTED') return { label: 'Rejected — see Check-in', tone: 'danger' };
  if (state === 'RECORDED') return { label: 'Checked in', tone: 'success' };
  return null;
}

export function CashDrawerScreen(_props: Props) {
  const styles = useStyles();
  const cashier = useCashier((s) => s.cashier);
  useCashDrawerSync();
  const loaded = useCashDrawer((s) => s.loaded);
  const open = useCashDrawer((s) => s.open);
  const terminalId = useCashDrawer((s) => s.terminalId);

  const [tally, setTally] = useState<DrawerTally | null>(null);
  const [movements, setMovements] = useState<LocalDrawerMovement[]>([]);
  const [history, setHistory] = useState<LocalDrawerSession[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | DrawerMovementKind>(null);
  // The session being closed — kept here because `open` turns null the moment the close is saved, while the sheet must
  // stay up to show the expected cash and the over/short.
  const [closing, setClosing] = useState<LocalDrawerSession | null>(null);

  const openUuid = open?.client_uuid ?? null;
  const reload = useCallback(async () => {
    try {
      const [t, m, h] = await Promise.all([
        openUuid ? localStore.getDrawerTally(openUuid) : Promise.resolve(null),
        openUuid ? localStore.listDrawerMovements(openUuid) : Promise.resolve([]),
        localStore.listClosedDrawerSessions(businessDate(new Date())),
      ]);
      setTally(t);
      setMovements(m);
      setHistory(h);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e, 'The cash drawer could not be read.'));
    }
  }, [openUuid]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  // Sales, drawer ops and sync results all change the figures.
  useEffect(() => onLocalStoreEvent(() => void reload()), [reload]);

  const otherTerminal = open && terminalId !== null && open.pos_terminal_id !== terminalId;

  return (
    <Screen title="Cash drawer">
      {loadError ? <Banner kind="danger" message={loadError} style={styles.gap} /> : null}
      {!loaded ? null : open ? (
        <>
          {otherTerminal ? (
            <Banner
              kind="warning"
              title="Opened for another terminal"
              message={`This drawer was opened on terminal ${open.terminal_name}. Count and close it, then open the drawer for this terminal.`}
              style={styles.gap}
            />
          ) : null}
          <OpenSession
            session={open}
            tally={tally}
            movements={movements}
            onSheet={(s) => (s === 'close' ? setClosing(open) : setSheet(s))}
            disabled={!cashier}
          />
        </>
      ) : (
        <OpenDrawerForm disabled={!cashier} />
      )}

      <Card title="Closed today" style={styles.gap}>
        {history.length === 0 ? (
          <Text style={styles.empty}>No drawer has been closed on this device today.</Text>
        ) : (
          history.map((s) => <ClosedSessionRow key={s.client_uuid} session={s} />)
        )}
      </Card>

      {open && cashier ? (
        <MovementSheet kind={sheet} session={open} cashier={{ id: cashier.userId, name: cashier.name }} onClose={() => setSheet(null)} />
      ) : null}
      {closing && cashier ? (
        <CloseSheet session={closing} cashier={{ id: cashier.userId, name: cashier.name }} onClose={() => setClosing(null)} />
      ) : null}
    </Screen>
  );
}

// ---- no open session ---------------------------------------------------------------------------------------------

function OpenDrawerForm({ disabled }: { disabled: boolean }) {
  const styles = useStyles();
  const cashier = useCashier((s) => s.cashier);
  const [float, setFloat] = useState('');
  // Counting by denomination fills the float; typing the float (or a quick chip) clears the counts.
  const [counts, setCounts] = useState<DenominationCounts>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const countFloat = (next: DenominationCounts) => {
    setCounts(next);
    setFloat(denominationAmountText(next));
  };

  const submit = () => {
    if (!cashier) return;
    const t = float.trim();
    if (!t || !isMoneyText(t)) {
      setError('Enter the opening float (use 0 if the drawer starts empty).');
      return;
    }
    setError(null);
    const breakdown = hasDenominationCounts(counts) ? `
${denominationSummary(counts)}` : '';
    Alert.alert('Open the cash drawer?', `Opening float: ${formatPeso(Number(t))}${breakdown}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open drawer',
        onPress: async () => {
          setBusy(true);
          try {
            await localStore.openDrawer({ cashierUserId: cashier.userId, cashierName: cashier.name, openingFloat: t });
            setFloat('');
            setCounts({});
            syncEngine.syncNow().catch(() => undefined);
          } catch (e) {
            setError(errorMessage(e, 'The drawer could not be opened.'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <Card title="Open drawer" style={styles.gap}>
      <Text style={styles.body}>
        Count the change fund in the drawer and enter it as the opening float. Selling starts once the drawer is open.
      </Text>
      <TextField
        label="Opening float (₱)"
        value={float}
        onChangeText={(v) => {
          setCounts({});
          setFloat(cleanDecimalInput(v));
        }}
        keyboardType="decimal-pad"
        placeholder="0.00"
        editable={!disabled && !busy}
        containerStyle={styles.field}
      />
      <View style={styles.chips}>
        {QUICK_FLOATS.map((v) => (
          <Chip key={v} label={formatPeso(v)} selected={float !== '' && Number(float) === v} onPress={() => {
              setCounts({});
              setFloat(String(v));
            }}
            disabled={disabled || busy}
          />
        ))}
      </View>
      <DenominationCounter counts={counts} onChange={countFloat} disabled={disabled || busy} title="Or count the change fund by denomination" />
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Button title="Open drawer" onPress={submit} loading={busy} disabled={disabled} style={styles.mainAction} />
    </Card>
  );
}

// ---- open session ------------------------------------------------------------------------------------------------

function OpenSession({
  session,
  tally,
  movements,
  onSheet,
  disabled,
}: {
  session: LocalDrawerSession;
  tally: DrawerTally | null;
  movements: LocalDrawerMovement[];
  onSheet: (s: DrawerMovementKind | 'close') => void;
  disabled: boolean;
}) {
  const styles = useStyles();
  const badge = syncBadge(session.sync_status);
  return (
    <>
      <Card title="Drawer open" right={badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : undefined} style={styles.gap}>
        <Text style={styles.meta}>
          Opened by {session.opened_by.name} · {formatDateTime(session.opened_at)} · {session.terminal_name}
        </Text>
        <SummaryRow label="Opening float" value={formatPeso(session.opening_float)} />
        <SummaryRow
          label={`Cash sales${tally ? ` (${tally.salesCount} sale${tally.salesCount === 1 ? '' : 's'})` : ''}`}
          value={tally ? formatPeso(tally.cashSales) : '…'}
        />
        {tally && tally.refundsCount > 0 ? <SummaryRow label="Cash refunds" value={formatPeso(tally.cashRefunds)} /> : null}
        <SummaryRow label="Cash in" value={tally ? formatPeso(tally.cashIn) : '…'} />
        <SummaryRow label="Cash out" value={tally ? formatPeso(tally.cashOut) : '…'} />
        {tally && tally.uncountedRefunds > 0 ? (
          <Text style={styles.caption}>
            {tally.uncountedRefunds} refund(s) of sales from another terminal aren’t included here — the server’s tally includes them.
          </Text>
        ) : null}
        <Text style={styles.caption}>The expected cash is shown after the closing count is submitted.</Text>
        <View style={styles.actions}>
          <Button title="Cash in" variant="secondary" onPress={() => onSheet('CASH_IN')} disabled={disabled} style={styles.action} />
          <Button title="Cash out" variant="secondary" onPress={() => onSheet('CASH_OUT')} disabled={disabled} style={styles.action} />
          <Button title="Close drawer" onPress={() => onSheet('close')} disabled={disabled} style={styles.action} />
        </View>
      </Card>

      <Card title="Cash in / out" style={styles.gap}>
        {movements.length === 0 ? (
          <Text style={styles.empty}>No cash added or taken out yet.</Text>
        ) : (
          movements.map((m) => <MovementRow key={m.client_uuid} movement={m} />)
        )}
      </Card>
    </>
  );
}

function MovementRow({ movement: m }: { movement: LocalDrawerMovement }) {
  const styles = useStyles();
  const c = useThemeColors();
  const badge = syncBadge(m.sync_status === 'RECORDED' ? null : m.sync_status);
  const isIn = m.kind === 'CASH_IN';
  return (
    <View style={styles.row}>
      <Text style={styles.rowTime}>{formatTime(m.occurred_at)}</Text>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{isIn ? 'Cash in' : 'Cash out'}</Text>
        <Text style={styles.caption} numberOfLines={2}>
          {m.reason} · {m.user.name}
        </Text>
      </View>
      {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
      <Text style={[styles.rowAmount, { color: isIn ? c.success : c.danger }]}>
        {isIn ? '+' : '−'}
        {formatPeso(m.amount)}
      </Text>
    </View>
  );
}

// ---- closed sessions ---------------------------------------------------------------------------------------------

function ClosedSessionRow({ session: s }: { session: LocalDrawerSession }) {
  const styles = useStyles();
  const c = useThemeColors();
  const counted = Number(s.counted_cash ?? 0);
  const expected = Number(s.expected_cash ?? 0);
  const v = varianceOf(counted, expected);
  const toneColor = v.tone === 'success' ? c.success : v.tone === 'danger' ? c.danger : c.warning;
  const badge = syncBadge(s.close_sync_status === 'RECORDED' && s.sync_status === 'RECORDED' ? null : (s.close_sync_status ?? s.sync_status));
  return (
    <View style={styles.historyRow}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>
          {formatTime(s.opened_at)} – {formatTime(s.closed_at)} · {s.terminal_name}
        </Text>
        <Text style={styles.caption}>
          Opened by {s.opened_by.name} · closed by {s.closed_by?.name ?? '—'} · float {formatPeso(s.opening_float)}
        </Text>
        <Text style={styles.caption}>
          Expected {formatPeso(expected)} · counted {formatPeso(counted)}
          {s.close_note ? ` · “${s.close_note}”` : ''}
        </Text>
      </View>
      {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
      <View style={styles.varianceBox}>
        <Text style={[styles.varianceLabel, { color: toneColor }]}>{v.label}</Text>
        <Text style={[styles.rowAmount, { color: toneColor }]}>{v.amount === 0 ? formatPeso(0) : formatPeso(v.amount)}</Text>
      </View>
    </View>
  );
}

// ---- cash in / cash out ------------------------------------------------------------------------------------------

function MovementSheet({
  kind,
  session,
  cashier,
  onClose,
}: {
  kind: DrawerMovementKind | null;
  session: LocalDrawerSession;
  cashier: { id: number; name: string };
  onClose: () => void;
}) {
  const styles = useStyles();
  const [amount, setAmount] = useState('');
  const [counts, setCounts] = useState<DenominationCounts>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind) {
      setAmount('');
      setCounts({});
      setReason('');
      setError(null);
    }
  }, [kind]);

  const isIn = kind === 'CASH_IN';
  const save = async () => {
    if (!kind) return;
    const a = amount.trim();
    if (!a || !isMoneyText(a) || !(Number(a) > 0)) return setError('Enter an amount greater than zero (at most 2 decimals).');
    if (!reason.trim()) return setError('Enter the reason.');
    setBusy(true);
    setError(null);
    try {
      await localStore.recordDrawerMovement({
        sessionUuid: session.client_uuid,
        cashierUserId: cashier.id,
        cashierName: cashier.name,
        kind,
        amount: a,
        reason,
      });
      syncEngine.syncNow().catch(() => undefined);
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'This could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={kind !== null}
      title={isIn ? 'Cash in' : 'Cash out'}
      onClose={busy ? () => undefined : onClose}
      width={640}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} style={styles.action} />
          <Button title={isIn ? 'Add cash' : 'Take cash out'} onPress={save} loading={busy} style={styles.action} />
        </View>
      }
    >
      <Text style={styles.body}>
        {isIn ? 'Money put into the drawer, e.g. a change fund top-up.' : 'Money taken out of the drawer, e.g. a payout or a cash pick-up.'}
      </Text>
      <TextField
        label="Amount (₱)"
        value={amount}
        onChangeText={(v) => {
          setCounts({});
          setAmount(cleanDecimalInput(v));
        }}
        keyboardType="decimal-pad"
        placeholder="0.00"
        editable={!busy}
        containerStyle={styles.field}
      />
      <TextField
        label="Reason"
        value={reason}
        onChangeText={setReason}
        maxLength={DRAWER_REASON_MAX}
        placeholder={isIn ? 'e.g. Change fund top-up' : 'e.g. Cash pick-up by the branch head'}
        editable={!busy}
        containerStyle={styles.field}
      />
      <DenominationCounter
        counts={counts}
        onChange={(next) => {
          setCounts(next);
          setAmount(denominationAmountText(next));
        }}
        disabled={busy}
        title="Or count it by denomination"
      />
      {error ? <Banner kind="danger" message={error} /> : null}
    </Sheet>
  );
}

// ---- close (blind count) -----------------------------------------------------------------------------------------

/** Mounted only while closing (fresh state each time). */
function CloseSheet({
  session,
  cashier,
  onClose,
}: {
  session: LocalDrawerSession;
  cashier: { id: number; name: string };
  onClose: () => void;
}) {
  const styles = useStyles();
  const c = useThemeColors();
  const [counted, setCounted] = useState('');
  const [counts, setCounts] = useState<DenominationCounts>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ expected: number; counted: number } | null>(null);

  const submit = () => {
    const t = counted.trim();
    if (!t || !isMoneyText(t)) {
      setError('Enter the cash you counted (at most 2 decimals).');
      return;
    }
    setError(null);
    const breakdown = hasDenominationCounts(counts) ? ` (${denominationSummary(counts)})` : '';
    Alert.alert('Submit the count?', `Counted cash: ${formatPeso(Number(t))}${breakdown}. The drawer is closed and the count can’t be changed afterwards.`, [
      { text: 'Recount', style: 'cancel' },
      {
        text: 'Submit',
        onPress: async () => {
          setBusy(true);
          try {
            const res = await localStore.closeDrawer({
              sessionUuid: session.client_uuid,
              cashierUserId: cashier.id,
              cashierName: cashier.name,
              countedCash: t,
              note: note.trim() || null,
            });
            syncEngine.syncNow().catch(() => undefined);
            setResult({ expected: Number(res.session.expected_cash ?? 0), counted: Number(res.session.counted_cash ?? 0) });
          } catch (e) {
            setError(errorMessage(e, 'The drawer could not be closed.'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  // The session is closed once `result` is set: the only way out is Done.
  const done = onClose;
  const v = result ? varianceOf(result.counted, result.expected) : null;
  const toneColor = v ? (v.tone === 'success' ? c.success : v.tone === 'danger' ? c.danger : c.warning) : c.text;
  const toneBg = v ? (v.tone === 'success' ? c.successSoft : v.tone === 'danger' ? c.dangerSoft : c.warningSoft) : c.surface;

  return (
    <Sheet
      visible
      title={result ? 'Drawer closed' : 'Close drawer — count the cash'}
      onClose={busy ? () => undefined : result ? done : onClose}
      width={680}
      footer={
        result ? (
          <View style={styles.footer}>
            <Button title="Done" onPress={done} style={styles.action} />
          </View>
        ) : (
          <View style={styles.footer}>
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} style={styles.action} />
            <Button title="Submit count" onPress={submit} loading={busy} style={styles.action} />
          </View>
        )
      }
    >
      {result && v ? (
        <>
          <SummaryRow label="Expected cash" value={formatPeso(result.expected)} />
          <SummaryRow label="Counted cash" value={formatPeso(result.counted)} />
          <View style={[styles.varianceBanner, { backgroundColor: toneBg }]}>
            <Text style={[styles.varianceBig, { color: toneColor }]}>{v.label}</Text>
            <Text style={[styles.varianceBig, { color: toneColor }]}>{formatPeso(v.amount)}</Text>
          </View>
          <Text style={styles.caption}>
            The close is saved on this device and sent to the server, which computes the official figure.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.body}>
            Count all the cash in the drawer — by denomination below, or type the total. The expected amount is shown only after you submit.
          </Text>
          <TextField
            label="Counted cash (₱)"
            value={counted}
            onChangeText={(val) => {
              setCounts({});
              setCounted(cleanDecimalInput(val));
            }}
            keyboardType="decimal-pad"
            placeholder="0.00"
            editable={!busy}
            containerStyle={styles.field}
          />
          <DenominationCounter
            counts={counts}
            onChange={(next) => {
              setCounts(next);
              setCounted(denominationAmountText(next));
            }}
            disabled={busy}
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            maxLength={DRAWER_NOTE_MAX}
            multiline
            editable={!busy}
            containerStyle={styles.field}
          />
          {error ? <Banner kind="danger" message={error} /> : null}
        </>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  gap: { marginBottom: spacing.lg },
  body: { ...t.body, color: c.text, marginBottom: spacing.md },
  meta: { ...t.label, marginBottom: spacing.sm },
  caption: { ...t.caption, marginTop: spacing.xs },
  empty: { ...t.body, color: c.muted, paddingVertical: spacing.md },
  field: { marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  mainAction: { minHeight: 52, alignSelf: 'flex-start', minWidth: 220 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg },
  action: { flexGrow: 1, flexBasis: 160 },
  footer: { flexDirection: 'row', gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  rowTime: { ...t.caption, width: 72 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { ...t.bodyStrong },
  rowAmount: { ...t.money, minWidth: 110, textAlign: 'right' },
  varianceBox: { alignItems: 'flex-end', minWidth: 110 },
  varianceLabel: { ...t.overline, color: c.text },
  varianceBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  varianceBig: { ...t.title },
}));
