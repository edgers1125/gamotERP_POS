// Pieces of the statutory card form shared by the client form (the sale's first card — ClientDialog) and the "Add
// another card" form (ExtraCardDialog, Phase 2b): the Solo Parent block (booklet no., the children the discount is for,
// the prescription attestation) and the ID expiry field's label. The rules are src/sale/statutory.ts (→ the backend's
// `@shared/statutory-rules`); this only collects what the cashier types.
import { Pressable, Text, View } from 'react-native';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { MAX_SOLO_PARENT_CHILDREN, type SoloParentChildDraft, type StatutoryType } from '../../sale/statutory';
import { HintText } from './ui';

/** Keeps a typed date to digits and dashes (YYYY-MM-DD). */
export const cleanDate = (t: string) => t.replace(/[^0-9-]/g, '').slice(0, 10);

/** The expiry field's label (required for PWD / Solo Parent, optional NAAC / Medal of Valor; none for Senior). */
export function expiryLabel(type: StatutoryType): string | null {
  if (type === 'SENIOR') return null;
  return type === 'PWD' || type === 'SOLO_PARENT' ? 'ID expiry date *' : 'ID expiry date (if any)';
}

/** What the issuer field says for the type. */
export function issuerLabel(type: StatutoryType): string {
  switch (type) {
    case 'SENIOR':
    case 'PWD':
      return 'Issued by (LGU / OSCA / NCDA)';
    case 'SOLO_PARENT':
      return 'Issued by (LGU / MSWDO)';
    case 'NAAC':
      return 'Issued by (PSC)';
    case 'MEDAL_OF_VALOR':
      return 'Issued by (AFP)';
  }
}

export function SoloParentFields({
  bookletNumber,
  kids: children,
  rxInChildName,
  rxLine,
  onBooklet,
  onKids: onChildren,
  onRxInChildName,
}: {
  bookletNumber: string;
  /** The children the discount is for (not `children` — that's React's). */
  kids: SoloParentChildDraft[];
  rxInChildName: boolean;
  /** A line getting this card is a prescription item → the attestation is asked. */
  rxLine: boolean;
  onBooklet: (v: string) => void;
  onKids: (v: SoloParentChildDraft[]) => void;
  onRxInChildName: (v: boolean) => void;
}) {
  const styles = useStyles();
  const setChild = (i: number, patch: Partial<SoloParentChildDraft>) => onChildren(children.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <View style={styles.root}>
      <TextField label="Solo Parent booklet no. (optional)" value={bookletNumber} onChangeText={onBooklet} maxLength={64} autoCapitalize="characters" />
      <Text style={styles.title}>Child the discount is for *</Text>
      <HintText>For the child’s own medicines, vaccines, milk, supplements or diapers — the child must be 6 years old or younger today.</HintText>
      {children.map((ch, i) => (
        <View key={i} style={styles.row}>
          <TextField label="Child’s full name" value={ch.name} onChangeText={(t) => setChild(i, { name: t })} maxLength={150} containerStyle={styles.name} />
          <TextField
            label="Birth date"
            value={ch.birthDate}
            onChangeText={(t) => setChild(i, { birthDate: cleanDate(t) })}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            containerStyle={styles.date}
          />
          <Button title="Remove" variant="ghost" compact onPress={() => onChildren(children.filter((_, j) => j !== i))} />
        </View>
      ))}
      {children.length < MAX_SOLO_PARENT_CHILDREN ? (
        <Button
          title={children.length === 0 ? '+ Add the child' : '+ Add another child'}
          variant="secondary"
          compact
          onPress={() => onChildren([...children, { name: '', birthDate: '' }])}
          style={styles.add}
        />
      ) : null}
      {rxLine ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: rxInChildName }}
          onPress={() => onRxInChildName(!rxInChildName)}
          style={styles.attest}
          hitSlop={6}
        >
          <View style={[styles.box, rxInChildName && styles.boxOn]}>{rxInChildName ? <Text style={styles.tick}>✓</Text> : null}</View>
          <Text style={styles.attestText}>The prescription for the prescription item(s) is in the child’s name *</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { marginTop: spacing.sm },
  title: { ...t.bodyStrong, fontSize: 14, marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  name: { flex: 2 },
  date: { flex: 1 },
  add: { alignSelf: 'flex-start', marginTop: spacing.xs },
  attest: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, minHeight: 44 },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  boxOn: { borderColor: c.primary, backgroundColor: c.primary },
  tick: { ...t.bodyStrong, color: c.onPrimary, fontSize: 14, lineHeight: 18 },
  attestText: { ...t.body, flex: 1 },
}));
