// Doctor picker of a NEW prescription: a search box over the cached doctors list (name, clinic, PRC, specialty), rows
// with their details, and a last row "Doctor not in the list — add" (online only). A doctor with no PRC on file
// can still be picked — the picked-doctor card then asks for "Fill in missing details" (online).
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PosPrescriptionDoctor } from '@pos-api/contract';
import { searchDoctors } from '../../sale/prescription';
import { TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { HintText } from '../sale/ui';

export function DoctorPicker({
  doctors,
  truncated,
  online,
  onPick,
  onAdd,
}: {
  doctors: readonly PosPrescriptionDoctor[];
  truncated: boolean;
  online: boolean;
  onPick: (d: PosPrescriptionDoctor) => void;
  onAdd: () => void;
}) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => searchDoctors(doctors, query), [doctors, query]);
  return (
    <View>
      <TextField label="Search doctors" value={query} onChangeText={setQuery} placeholder="Name, clinic, PRC no. or specialty" autoCorrect={false} />
      {truncated ? <HintText>Only the first 5,000 doctors are on this tablet.</HintText> : null}
      <View style={styles.list}>
        {rows.length === 0 ? <Text style={styles.empty}>{doctors.length === 0 ? 'No doctors on this tablet yet.' : 'No doctor matches.'}</Text> : null}
        {rows.map((d) => (
          <Pressable key={d.id} accessibilityRole="button" onPress={() => onPick(d)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <Text style={styles.name}>{d.name}</Text>
            <Text style={styles.meta}>
              {[d.clinic, d.license_number ? `PRC ${d.license_number}` : null, d.specialty].filter(Boolean).join('  ·  ') || '—'}
            </Text>
            {!d.usable ? <Text style={styles.warn}>No PRC licence on file</Text> : null}
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !online }}
          disabled={!online}
          onPress={onAdd}
          style={({ pressed }) => [styles.row, styles.addRow, pressed && styles.rowPressed]}
        >
          <Text style={[styles.name, !online && styles.disabled]}>Doctor not in the list — add</Text>
          {!online ? <Text style={styles.meta}>Adding a doctor needs a connection</Text> : null}
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  list: { marginTop: spacing.sm, gap: spacing.xs },
  empty: { ...t.body, color: c.muted, paddingVertical: spacing.sm },
  row: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    backgroundColor: c.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 52,
    justifyContent: 'center',
  },
  rowPressed: { backgroundColor: c.primarySoft },
  addRow: { borderStyle: 'dashed', borderColor: c.borderStrong },
  name: { ...t.subtitle },
  disabled: { color: c.disabled },
  meta: { ...t.caption },
  warn: { ...t.caption, color: c.warning },
}));
