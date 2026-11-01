// The Solo Parent part of a statutory card (RA 11861): booklet number (optional), the children the discount is for
// (1–10, name + birth date YYYY-MM-DD, each 6 or younger on the sale day — checked by statutory.ts `statutoryProblem`) and,
// only when a prescription item on the sale is eligible, the cashier's attestation that the prescription is in the
// child's name. Shared by ClientDialog (card 0) and ExtraCardDialog (further cards). Controlled — the parent owns the draft.
import { Pressable, Switch, Text, View } from 'react-native';
import { Button, TextField } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import type { SoloParentChildDraft } from '../../sale/statutory';
import { HintText } from './ui';

export const MAX_SOLO_PARENT_CHILDREN = 10;
export const EMPTY_CHILD: SoloParentChildDraft = { name: '', birthDate: '' };

const cleanDate = (t: string) => t.replace(/[^0-9-]/g, '').slice(0, 10);

export function SoloParentFields({
  bookletNumber,
  children,
  rxInChildName,
  showRxToggle,
  onBookletNumber,
  onChildren,
  onRxInChildName,
}: {
  bookletNumber: string;
  children: SoloParentChildDraft[];
  rxInChildName: boolean;
  /** A prescription-only item on the sale is eligible for the Solo Parent discount. */
  showRxToggle: boolean;
  onBookletNumber: (v: string) => void;
  onChildren: (v: SoloParentChildDraft[]) => void;
  onRxInChildName: (v: boolean) => void;
}) {
  const styles = useStyles();
  const theme = useThemeColors();
  const rows = children.length === 0 ? [EMPTY_CHILD] : children;
  const setRow = (i: number, patch: Partial<SoloParentChildDraft>) => onChildren(rows.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <View style={styles.root}>
      <TextField label="Solo Parent ID booklet no. (optional)" value={bookletNumber} onChangeText={onBookletNumber} maxLength={64} autoCapitalize="characters" autoCorrect={false} />
      <Text style={styles.title}>Children the discount is for (6 years old or younger)</Text>
      {rows.map((c, i) => (
        <View key={i} style={styles.childRow}>
          <TextField label={`Child ${i + 1} name *`} value={c.name} onChangeText={(t) => setRow(i, { name: t })} maxLength={150} containerStyle={styles.name} />
          <TextField
            label="Birth date *"
            value={c.birthDate}
            onChangeText={(t) => setRow(i, { birthDate: cleanDate(t) })}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            containerStyle={styles.date}
          />
          {rows.length > 1 ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove child ${i + 1}`} hitSlop={8} onPress={() => onChildren(rows.filter((_, idx) => idx !== i))} style={styles.remove}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {rows.length < MAX_SOLO_PARENT_CHILDREN ? (
        <View style={styles.addRow}>
          <Button title="+ Add child" variant="secondary" compact onPress={() => onChildren([...rows, EMPTY_CHILD])} />
        </View>
      ) : null}
      {showRxToggle ? (
        <View style={styles.rxRow}>
          <Switch value={rxInChildName} onValueChange={onRxInChildName} trackColor={{ true: theme.primary }} />
          <Text style={styles.rxText}>The prescription is in the child’s name</Text>
        </View>
      ) : null}
      {showRxToggle ? <HintText>Needed for the Solo Parent discount on a prescription item.</HintText> : null}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { marginTop: spacing.xs },
  title: { ...t.bodyStrong, fontSize: 14, marginTop: spacing.xs },
  childRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  name: { flex: 2 },
  date: { flex: 1 },
  remove: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  removeText: { ...t.caption, color: c.danger, textDecorationLine: 'underline' },
  addRow: { alignSelf: 'flex-start', marginTop: spacing.xs },
  rxRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  rxText: { ...t.body, flex: 1 },
}));
