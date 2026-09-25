// Co-sign inputs shared by the void dialog and the refund screen: pick the approver (a user with the permission and
// MFA on, from the server's eligible list — cached on the device for offline voids), their 6-digit authenticator code
// (entered on this device by the approver), and the reason.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PosApprover } from '@pos-api/contract';

import { TextField } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';

export interface ApprovalValue {
  approverId: number | null;
  code: string;
  reason: string;
}

export const emptyApproval: ApprovalValue = { approverId: null, code: '', reason: '' };

/** First problem with the co-sign inputs, or null when complete. */
export function approvalProblem(v: ApprovalValue): string | null {
  if (v.approverId === null) return 'Choose who approves.';
  if (!/^\d{6}$/.test(v.code)) return 'Enter the approver’s 6-digit code.';
  if (!v.reason.trim()) return 'Enter a reason.';
  return null;
}

export interface ApprovalFieldsProps {
  approvers: PosApprover[];
  value: ApprovalValue;
  onChange: (v: ApprovalValue) => void;
  approverLabel: string;
  emptyText: string;
  disabled?: boolean;
}

export function ApprovalFields({ approvers, value, onChange, approverLabel, emptyText, disabled }: ApprovalFieldsProps) {
  return (
    <View>
      <Text style={styles.label}>{approverLabel}</Text>
      {approvers.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        <View style={styles.chips}>
          {approvers.map((a) => {
            const selected = a.id === value.approverId;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled }}
                disabled={disabled}
                onPress={() => onChange({ ...value, approverId: a.id })}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{a.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <TextField
        label="Approver's authenticator code"
        value={value.code}
        onChangeText={(t) => onChange({ ...value, code: t.replace(/\D/g, '').slice(0, 6) })}
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        autoComplete="off"
        importantForAutofill="no"
        editable={!disabled}
        placeholder="6 digits"
      />
      <TextField
        label="Reason"
        value={value.reason}
        onChangeText={(t) => onChange({ ...value, reason: t.slice(0, 500) })}
        editable={!disabled}
        multiline
        placeholder="Why?"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: font.small, color: colors.muted, marginBottom: spacing.xs, fontWeight: '600' },
  empty: { color: colors.warning, fontSize: font.small, marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: font.body },
  chipTextSelected: { color: '#ffffff', fontWeight: '600' },
});
