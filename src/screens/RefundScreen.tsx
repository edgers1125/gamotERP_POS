// Refund a whole sale from an EARLIER business day — ONLINE only (contract POST /pos/refunds; same day → void).
// The device assigns the return number from its own counter: peekReturnSeq() before the call, commitReturnSeq() only
// once the server has recorded it. One attempt = one client_uuid + return_seq, reused on retry (the server is
// idempotent by client_uuid), so a request that reached the server but whose answer was lost comes back as DUPLICATE
// instead of refunding twice. The in-flight attempt is kept in the secure store until it has a definite answer, so
// leaving the screen or restarting the app can't orphan a return number the server may already have used.
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import type { PosApprover, PosRefundRequest, PosRefundResponse } from '@pos-api/contract';
import { formatInvoiceNumber } from '@shared/invoice-number';

import type { RootStackParamList } from '../../App';
import { api } from '../api/client';
import { cashierSession, useCashier } from '../auth/cashierSession';
import { ApprovalFields, approvalProblem, emptyApproval, type ApprovalValue } from '../components/shell/ApprovalFields';
import { loadApprovers } from '../components/shell/approvers';
import { errorMessage } from '../components/shell/format';
import { ApiError } from '../contracts';
import { localStore } from '../db/localStore';
import { useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, Card, Screen, TextField } from '../ui/components';
import { colors, font, spacing } from '../ui/theme';

export type RefundParams = { batchId?: number; invoiceNumber?: string; saleClientUuid?: string } | undefined;

type Props = NativeStackScreenProps<RootStackParamList, 'Refund'>;

interface Attempt {
  clientUuid: string;
  returnSeq: number;
  sale: PosRefundRequest['sale'];
  label: string; // invoice number (or reference) shown to the cashier
  saleClientUuid: string | null; // the sale's client_uuid when it was rung up on this device
}

const PENDING_KEY = 'pos.refund.inflight';

async function readPending(): Promise<Attempt | null> {
  try {
    const raw = await SecureStore.getItemAsync(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Attempt) : null;
  } catch {
    return null;
  }
}
const writePending = (a: Attempt) => SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(a));
const clearPending = () => SecureStore.deleteItemAsync(PENDING_KEY).catch(() => undefined);

export function RefundScreen({ route, navigation }: Props) {
  const fromRow = route.params ?? {};
  const online = useSyncStatus((s) => s.online);
  const cashier = useCashier((s) => s.cashier);
  const onlineSession = cashier?.mode === 'ONLINE' && cashierSession.isOnlineSession();
  const [invoiceNumber, setInvoiceNumber] = useState(fromRow.invoiceNumber ?? '');
  const [approvers, setApprovers] = useState<PosApprover[]>([]);
  const [value, setValue] = useState<ApprovalValue>(emptyApproval);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [nextSeq, setNextSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ res: PosRefundResponse; seq: number } | null>(null);
  // An attempt that got no answer (this session or an earlier one) — it must be retried before anything else.
  const [pending, setPending] = useState<Attempt | null>(null);

  useEffect(() => {
    let alive = true;
    readPending().then((p) => alive && p && setPending(p));
    localStore
      .getEnrollment()
      .then((e) => alive && setPrefix(e?.terminal.invoice_prefix ?? null))
      .catch(() => undefined);
    localStore
      .peekReturnSeq()
      .then((n) => alive && setNextSeq(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    loadApprovers('REFUND', online && !!onlineSession).then((l) => alive && setApprovers(l));
    return () => {
      alive = false;
    };
  }, [online, onlineSession]);

  const submit = async () => {
    setError(null);
    if (!online) return setError('Refunds need a connection.');
    if (!cashierSession.isOnlineSession()) return setError('Sign in with your password (not the PIN) to refund.');
    const typed = invoiceNumber.trim();
    if (!pending && !typed) return setError('Enter the invoice number of the sale to refund.');
    const problem = approvalProblem(value);
    if (problem) return setError(problem);

    setBusy(true);
    try {
      let a = pending;
      if (!a) {
        const useBatch = fromRow.batchId !== undefined && typed === (fromRow.invoiceNumber ?? '').trim();
        a = {
          clientUuid: Crypto.randomUUID(),
          returnSeq: await localStore.peekReturnSeq(),
          sale: useBatch ? { batch_id: fromRow.batchId! } : { invoice_number: typed },
          label: typed,
          saleClientUuid: useBatch ? (fromRow.saleClientUuid ?? null) : null,
        };
        await writePending(a);
      }
      let res: PosRefundResponse;
      try {
        res = await api.refund({
          client_uuid: a.clientUuid,
          sale: a.sale,
          return_seq: a.returnSeq,
          reason: value.reason.trim(),
          approval: { approved_by_user_id: value.approverId!, approval_code: value.code },
        });
      } catch (e) {
        if (e instanceof ApiError && e.isNetwork) {
          setPending(a);
          setError('No answer from the server — the refund may or may not have been recorded. Tap "Check / retry" (it can never refund twice).');
        } else {
          // Refused outright (bad code, not refundable…): nothing was recorded and the return number stays free.
          await clearPending();
          setPending(null);
          setError(errorMessage(e, 'The refund was refused.'));
        }
        return;
      }
      if (res.status !== 'REJECTED') {
        // Commit BEFORE forgetting the attempt: a crash in between only means one more (DUPLICATE) retry.
        await localStore.commitReturnSeq(a.returnSeq);
        if (a.saleClientUuid) await localStore.markRefunded(a.saleClientUuid).catch(() => undefined);
      }
      await clearPending();
      setPending(null);
      if (res.status === 'REJECTED') {
        setError(res.error ?? 'The refund was refused.');
        return;
      }
      setResult({ res, seq: a.returnSeq });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const discardPending = () => {
    Alert.alert(
      'Discard the unanswered refund?',
      'Only do this if you have checked (e.g. in Branch Sales on the web) that this refund was NOT recorded. If it was, its return number would be used twice.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            await clearPending();
            setPending(null);
            setError(null);
          },
        },
      ],
    );
  };

  if (result) {
    const { res, seq } = result;
    return (
      <Screen title="Refund recorded">
        <Card>
          <Text style={styles.big}>{res.invoice_number ?? (prefix ? formatInvoiceNumber(prefix, 'RETURN', seq) : '—')}</Text>
          {res.reference ? <Text style={styles.meta}>Reference {res.reference}</Text> : null}
          {res.status === 'DUPLICATE' ? <Text style={styles.meta}>This refund had already been recorded.</Text> : null}
          {res.exceptions.map((x, i) => (
            <Banner key={i} kind="warning" title={x.kind} message={x.message} style={styles.gap} />
          ))}
        </Card>
        <Button title="Back to sales" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  const seqShown = pending?.returnSeq ?? nextSeq;
  const predicted = prefix && seqShown !== null ? formatInvoiceNumber(prefix, 'RETURN', seqShown) : null;

  return (
    <Screen title="Refund a sale">
      {!online ? <Banner kind="warning" title="Offline" message="Refunds need a connection. Try again when the device is online." style={styles.gap} /> : null}
      {online && !onlineSession ? (
        <Banner
          kind="warning"
          title="Password sign-in needed"
          message="You unlocked with a PIN. Refunds need an online sign-in with your password."
          actionLabel="Sign in"
          onAction={() => cashierSession.logout()}
          style={styles.gap}
        />
      ) : null}
      {pending ? (
        <Banner
          kind="warning"
          title="Unanswered refund"
          message={`A refund of ${pending.label} got no answer from the server. Check it first: enter the approval again and tap "Check / retry".`}
          actionLabel="Discard"
          onAction={discardPending}
          style={styles.gap}
        />
      ) : null}
      <Card title="Sale">
        <TextField
          label="Invoice number of the sale"
          value={pending ? pending.label : invoiceNumber}
          onChangeText={setInvoiceNumber}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy && !pending}
          placeholder="e.g. POS1-000123"
          hint="The whole sale is refunded. Sales from today are voided instead."
        />
        {predicted ? <Text style={styles.meta}>This refund will be numbered {predicted}.</Text> : null}
      </Card>
      <Card title="Approval">
        <ApprovalFields
          approvers={approvers}
          value={value}
          onChange={setValue}
          approverLabel="Approved by (refund approver)"
          emptyText="No refund approvers found. They need the refund permission and two-factor sign-in turned on."
          disabled={busy}
        />
      </Card>
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <View style={styles.buttons}>
        <Button title="Cancel" variant="secondary" onPress={() => navigation.goBack()} disabled={busy} style={styles.flex} />
        <Button
          title={pending ? 'Check / retry refund' : 'Refund'}
          variant="danger"
          onPress={submit}
          loading={busy}
          disabled={!online || !onlineSession}
          style={styles.flex}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: spacing.sm, marginBottom: spacing.md },
  big: { fontSize: font.huge, fontWeight: '700', color: colors.primary },
  meta: { fontSize: font.small, color: colors.muted, marginTop: spacing.xs },
  buttons: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
});
