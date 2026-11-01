// A further statutory card on the sale (BIR Phase 2b — only while the company allows several: Settings → "One statutory
// discount per sale" off). Card 0 is the sale client's (ClientDialog); this edits ONE more card: its type (picked when
// adding, fixed when editing), ID number, the holder's name, issuer, birth date, expiry (per type) and — Solo Parent —
// booklet no. + children. No phone / sex / address: the server finds or creates the holder from the card. Saved into the
// cart with `setExtraCards`; the card is checked with `statutoryProblem`.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { statutoryIdHasExpiry, statutoryIdNeedsExpiry } from '@shared/statutory-rules';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import { lineEligibleFor, useCart, type CartLine } from '../../sale/cart';
import {
  EMPTY_STATUTORY,
  statutoryProblem,
  statutoryRuleText,
  statutoryTypeLabel,
  type StatutoryDraft,
  type StatutoryType,
} from '../../sale/statutory';
import { EMPTY_CHILD, SoloParentFields } from './SoloParentFields';
import { ErrorText, HintText, Segmented, Sheet } from './ui';

const cleanDate = (t: string) => t.replace(/[^0-9-]/g, '').slice(0, 10);

export function ExtraCardDialog({
  visible,
  card,
  availableTypes,
  lines,
  onSave,
  onRemove,
  onClose,
}: {
  visible: boolean;
  /** The card being edited (null = adding a new one). */
  card: StatutoryDraft | null;
  /** Types that can still be added (offered, not already on the sale). */
  availableTypes: StatutoryType[];
  lines: Pick<CartLine, 'scPwdEligible' | 'soloParentEligible' | 'rxRequired'>[];
  onSave: (draft: StatutoryDraft) => void;
  /** Editing only: take the card off the sale. */
  onRemove?: () => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const config = useCart((s) => s.statutoryConfig);
  const [draft, setDraft] = useState<StatutoryDraft>(EMPTY_STATUTORY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(
      card
        ? { ...card, children: card.children.length > 0 ? card.children : [EMPTY_CHILD] }
        : { ...EMPTY_STATUTORY, type: availableTypes[0] ?? 'SENIOR', children: [EMPTY_CHILD] },
    );
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const patch = (p: Partial<StatutoryDraft>) => setDraft((d) => ({ ...d, ...p }));
  const eligible = lines.filter((l) => lineEligibleFor(draft.type, l)).length;
  const rxToggle = lines.some((l) => l.rxRequired && lineEligibleFor('SOLO_PARENT', l));
  const problem =
    eligible === 0
      ? `No item in the cart qualifies for the ${statutoryTypeLabel(draft.type)} discount.`
      : statutoryProblem({ ...draft, rxInChildName: draft.type === 'SOLO_PARENT' && rxToggle ? draft.rxInChildName : false });

  function save() {
    if (problem) {
      setTouched(true);
      return;
    }
    onSave({
      ...draft,
      expiryDate: statutoryIdHasExpiry(draft.type) ? draft.expiryDate : '',
      bookletNumber: draft.type === 'SOLO_PARENT' ? draft.bookletNumber : '',
      children: draft.type === 'SOLO_PARENT' ? draft.children : [],
      rxInChildName: draft.type === 'SOLO_PARENT' && rxToggle ? draft.rxInChildName : false,
      phone: '',
      sex: '',
    });
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      title={card ? `${statutoryTypeLabel(card.type)} card` : 'Add another card'}
      onClose={onClose}
      width={720}
      footer={
        <>
          {card && onRemove ? (
            <Button
              title="Remove card"
              variant="ghost"
              onPress={() => {
                onRemove();
                onClose();
              }}
            />
          ) : null}
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title={card ? 'Save card' : 'Add card'} onPress={save} disabled={touched && problem !== null} />
        </>
      }
    >
      {!card && availableTypes.length > 1 ? (
        <Segmented<StatutoryType>
          options={availableTypes.map((t) => ({ value: t, label: statutoryTypeLabel(t) }))}
          value={draft.type}
          onChange={(t) => patch({ type: t })}
        />
      ) : null}
      <HintText>
        {statutoryTypeLabel(draft.type)} discount: {statutoryRuleText(config.rules[draft.type])} on {eligible} eligible item{eligible === 1 ? '' : 's'}. Each item takes one card’s
        discount — choose which on the item.
      </HintText>
      <View style={styles.row}>
        <TextField
          label="ID number *"
          value={draft.idNumber}
          onChangeText={(t) => patch({ idNumber: t })}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          containerStyle={styles.cell}
        />
        <TextField label="Issued by" value={draft.idIssuer} onChangeText={(t) => patch({ idIssuer: t })} maxLength={100} containerStyle={styles.cell} />
      </View>
      <View style={styles.row}>
        <TextField label="First name *" value={draft.firstName} onChangeText={(t) => patch({ firstName: t })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Middle name" value={draft.middleName} onChangeText={(t) => patch({ middleName: t })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Last name *" value={draft.lastName} onChangeText={(t) => patch({ lastName: t })} maxLength={100} containerStyle={styles.cell} />
      </View>
      <View style={styles.row}>
        <TextField
          label="Birth date (optional)"
          value={draft.birthDate}
          onChangeText={(t) => patch({ birthDate: cleanDate(t) })}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          containerStyle={styles.cell}
        />
        {statutoryIdHasExpiry(draft.type) ? (
          <TextField
            label={statutoryIdNeedsExpiry(draft.type) ? 'Expiry date *' : 'Expiry date (optional)'}
            value={draft.expiryDate}
            onChangeText={(t) => patch({ expiryDate: cleanDate(t) })}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            containerStyle={styles.cell}
          />
        ) : (
          <View style={styles.cell} />
        )}
      </View>
      {draft.type === 'SOLO_PARENT' ? (
        <SoloParentFields
          bookletNumber={draft.bookletNumber}
          children={draft.children}
          rxInChildName={draft.rxInChildName}
          showRxToggle={rxToggle}
          onBookletNumber={(v) => patch({ bookletNumber: v })}
          onChildren={(v) => patch({ children: v })}
          onRxInChildName={(v) => patch({ rxInChildName: v })}
        />
      ) : null}
      {touched && problem ? <ErrorText>{problem}</ErrorText> : null}
    </Sheet>
  );
}

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  cell: { flex: 1 },
}));
