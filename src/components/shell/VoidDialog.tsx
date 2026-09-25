// Void a sale rung up on THIS device, on the sale's own Manila business day (plan "Offline sales & sync": VOID ops are
// allowed offline; the co-signer's code is verified by the server against voided_at at sync). The VOID op is enqueued
// through localStore.recordVoid (signed like every op) and a sync is kicked off right away.
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PosApprover, VoidPayload } from '@pos-api/contract';
import { businessDate } from '@shared/business-day';

import { useCashier } from '../../auth/cashierSession';
import type { LocalSale } from '../../contracts';
import { localStore } from '../../db/localStore';
import { formatPeso } from '../../sale/money';
import { syncEngine, useSyncStatus } from '../../sync/syncEngine';
import { Banner, Button } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';
import { ApprovalFields, approvalProblem, emptyApproval, type ApprovalValue } from './ApprovalFields';
import { loadApprovers } from './approvers';
import { errorMessage } from './format';

export interface VoidDialogProps {
  sale: LocalSale | null;
  onClose: () => void;
  onVoided: () => void;
}

export function VoidDialog({ sale, onClose, onVoided }: VoidDialogProps) {
  const cashier = useCashier((s) => s.cashier);
  const online = useSyncStatus((s) => s.online);
  const [approvers, setApprovers] = useState<PosApprover[]>([]);
  const [value, setValue] = useState<ApprovalValue>(emptyApproval);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sale) return;
    setValue(emptyApproval);
    setError(null);
    let alive = true;
    loadApprovers('VOID', online).then((list) => alive && setApprovers(list));
    return () => {
      alive = false;
    };
    // Reload only when a different sale is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale?.client_uuid]);

  const submit = async () => {
    if (!sale || !cashier) return;
    const problem = approvalProblem(value);
    if (problem) {
      setError(problem);
      return;
    }
    const now = new Date();
    if (businessDate(new Date(sale.payload.sold_at)) !== businessDate(now)) {
      setError('This sale is from an earlier business day — refund it instead (needs a connection).');
      return;
    }
    const payload: VoidPayload = {
      cashier_user_id: cashier.userId,
      sale_client_uuid: sale.client_uuid,
      voided_at: now.toISOString(),
      reason: value.reason.trim(),
      approval: { approved_by_user_id: value.approverId!, approval_code: value.code },
    };
    setSaving(true);
    setError(null);
    try {
      await localStore.recordVoid(sale.client_uuid, payload);
      syncEngine.syncNow().catch(() => undefined);
      onVoided();
    } catch (e) {
      setError(errorMessage(e, 'The void could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={!!sale} transparent animationType="fade" onRequestClose={saving ? () => undefined : onClose}>
      <KeyboardAvoidingView behavior="height" style={styles.backdrop}>
        <View style={styles.dialog}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Void sale {sale?.invoice_number}</Text>
            {sale ? (
              <Text style={styles.subtitle}>
                Total {formatPeso(sale.payload.totals.grand_total)} — the whole sale is voided.
              </Text>
            ) : null}
            {!online ? (
              <Banner
                kind="info"
                message="Offline: the void is saved on this device and sent when the connection returns. The approver's code is checked then."
                style={styles.gap}
              />
            ) : null}
            <ApprovalFields
              approvers={approvers}
              value={value}
              onChange={setValue}
              approverLabel="Approved by (void approver)"
              emptyText="No void approvers are known on this device yet. Connect once while signed in with a password to load them."
              disabled={saving}
            />
            {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
            <View style={styles.buttons}>
              <Button title="Cancel" variant="secondary" onPress={onClose} disabled={saving} style={styles.flex} />
              <Button title="Void sale" variant="danger" onPress={submit} loading={saving} style={styles.flex} />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dialog: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  title: { fontSize: font.title, fontWeight: '700', color: colors.primary, marginBottom: spacing.xs },
  subtitle: { fontSize: font.body, color: colors.text, marginBottom: spacing.md },
  gap: { marginBottom: spacing.md },
  buttons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  flex: { flex: 1 },
});
