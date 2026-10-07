// Co-sign: the approver picks themselves from the eligible list (cached on the device — works offline) and types the
// 6-digit code from their authenticator app ON THIS DEVICE. The code isn't checked here: the server verifies it at
// sync against the sale's own time (sold_at), replay-guarded, and flags INVALID_APPROVAL_CODE if it's wrong.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { PosApprovalKind, PosApprover } from '@pos-api/contract';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import { loadApprovers, type Approval } from '../../sale/checkout';
import { HintText, OptionTile, Sheet } from './ui';

export function ApproverDialog({
  visible,
  kind,
  online,
  title = 'Approve the discount',
  explanation,
  busy,
  onApprove,
  onClose,
}: {
  visible: boolean;
  kind: PosApprovalKind;
  online: boolean;
  title?: string;
  explanation?: string;
  busy?: boolean;
  onApprove: (approval: Approval) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [approvers, setApprovers] = useState<PosApprover[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!visible) return;
    setPicked(null);
    setCode('');
    setApprovers(null);
    let live = true;
    loadApprovers(kind, online)
      .then((list) => {
        if (live) setApprovers(list);
      })
      .catch(() => {
        if (live) setApprovers([]);
      });
    return () => {
      live = false;
    };
  }, [visible, kind, online]);

  const codeOk = /^\d{6}$/.test(code);
  const canApprove = picked !== null && codeOk && !busy;

  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button title="Approve & complete" onPress={() => onApprove({ approvedByUserId: picked!, approvalCode: code })} disabled={!canApprove} loading={busy} />
        </>
      }
    >
      {explanation ? <Text style={styles.explain}>{explanation}</Text> : null}
      <Text style={styles.label}>Approver</Text>
      {approvers === null ? (
        <HintText>Loading approvers…</HintText>
      ) : approvers.length === 0 ? (
        <Text style={styles.warn}>
          No approvers are known on this device yet. Someone with discount approval and two-factor sign-in must exist — connect once so the list
          downloads.
        </Text>
      ) : (
        <View style={styles.grid}>
          {approvers.map((item) => (
            <OptionTile key={item.id} label={item.name} selected={item.id === picked} onPress={() => setPicked(item.id)} />
          ))}
        </View>
      )}
      <View style={{ height: spacing.md }} />
      <TextField
        label="Approver’s 6-digit code"
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        placeholder="••••••"
        style={styles.code}
        hint="The approver types the code from their authenticator app. It’s checked by the server when the device checks in."
      />
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  explain: { ...t.body, marginBottom: spacing.md },
  label: { ...t.label, marginBottom: spacing.xs },
  warn: { ...t.body, color: c.warning },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  code: { fontFamily: t.bodyStrong.fontFamily, fontSize: 28, letterSpacing: 8, textAlign: 'center', minHeight: 60 },
}));
