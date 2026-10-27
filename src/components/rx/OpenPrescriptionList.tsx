// The client's open prescriptions (GET /pos/clients/:id/open-prescriptions, fetched online during this sale): one
// tappable card each — reference, prescriber, dates, and per item "<model>: N of M left". The chosen one is highlighted.
import { Pressable, Text, View } from 'react-native';
import type { PosOpenPrescription } from '@pos-api/contract';
import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { StatusBadge } from '../sale/ui';

export function OpenPrescriptionList({
  rows,
  selectedId,
  onPick,
}: {
  rows: PosOpenPrescription[];
  selectedId: number | null;
  onPick: (p: PosOpenPrescription) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {rows.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityState={{ selected: p.id === selectedId }}
          onPress={() => onPick(p)}
          style={({ pressed }) => [styles.card, p.id === selectedId && styles.cardOn, pressed && styles.cardPressed]}
        >
          <View style={styles.head}>
            <Text style={styles.ref}>{p.reference}</Text>
            {p.is_dangerous_drug ? <StatusBadge label="DD" tone="warning" /> : null}
            {p.status === 'PARTIALLY_FILLED' ? <StatusBadge label="Partly filled" tone="info" /> : null}
          </View>
          <Text style={styles.meta}>
            {p.prescriber_name} · written {p.prescription_date} · valid until {p.valid_until}
          </Text>
          {p.items.map((it) => (
            <Text key={it.product_model_id} style={styles.item}>
              {it.model_name}: {it.quantity_remaining} of {it.quantity_prescribed} left{it.is_dangerous_drug ? ' · DD' : ''}
            </Text>
          ))}
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  list: { gap: spacing.sm },
  card: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.surface, padding: spacing.md, gap: 2 },
  cardOn: { borderColor: c.primary, backgroundColor: c.primarySoft },
  cardPressed: { backgroundColor: c.primarySoft },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ref: { ...t.subtitle },
  meta: { ...t.caption },
  item: { ...t.body },
}));
