// "Add another card" (BIR Phase 2b — only while the company's Settings → "One statutory discount per sale" is OFF): a
// further statutory card on the same sale, one per type, never the type of the sale's first card (the client's). The
// holder is typed here (the server links them at sync: the client already holding that card, the sale's client when
// it's the same name, else a new client — contract §2b "Holders"). Which lines get which card is chosen on each cart line.
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { statutoryIdHasExpiry } from '@shared/statutory-rules';
import { Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import {
  EMPTY_STATUTORY,
  ruleSummary,
  statutoryProblem,
  statutoryTypeLabel,
  type StatutoryConfig,
  type StatutoryDraft,
  type StatutoryType,
} from '../../sale/statutory';
import { cleanDate, expiryLabel, issuerLabel, SoloParentFields } from './StatutoryCardParts';
import { ErrorText, HintText, Segmented, Sheet } from './ui';

export function ExtraCardDialog({
  visible,
  types,
  value,
  config,
  eligibleCountFor,
  rxLineFor,
  onSave,
  onClose,
}: {
  visible: boolean;
  /** The types that may be added (offered, not yet on the sale) — or just the edited card's type. */
  types: StatutoryType[];
  /** The card being edited (null = a new one). */
  value: StatutoryDraft | null;
  config: StatutoryConfig;
  eligibleCountFor: (type: StatutoryType) => number;
  rxLineFor: (type: StatutoryType) => boolean;
  onSave: (draft: StatutoryDraft) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [draft, setDraft] = useState<StatutoryDraft>(EMPTY_STATUTORY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(value ?? { ...EMPTY_STATUTORY, type: types.find((t) => eligibleCountFor(t) > 0) ?? types[0] ?? 'SENIOR' });
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const set = (patch: Partial<StatutoryDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const type = draft.type;
  const problem = useMemo(() => {
    if (eligibleCountFor(type) === 0) return `No item in the cart qualifies for the ${statutoryTypeLabel(type)} discount.`;
    const d: StatutoryDraft = {
      ...draft,
      expiryDate: statutoryIdHasExpiry(type) ? draft.expiryDate : '',
      ...(type === 'SOLO_PARENT' ? {} : { bookletNumber: '', children: [], rxInChildName: false }),
    };
    return statutoryProblem(d, { config, rxLine: rxLineFor(type) });
  }, [draft, type, config, eligibleCountFor, rxLineFor]);

  function save() {
    if (problem) {
      setTouched(true);
      return;
    }
    onSave({
      ...draft,
      expiryDate: statutoryIdHasExpiry(type) ? draft.expiryDate : '',
      ...(type === 'SOLO_PARENT' ? {} : { bookletNumber: '', children: [], rxInChildName: false }),
    });
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      title={value ? `${statutoryTypeLabel(value.type)} card` : 'Add another card'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title={value ? 'Save card' : 'Add card'} onPress={save} disabled={touched && problem !== null} />
        </>
      }
    >
      <HintText>One card per type on a sale. Choose on each item which card it gets — an item gets one discount only.</HintText>
      {types.length > 1 ? (
        <Segmented<StatutoryType>
          options={types.map((t) => ({ value: t, label: t === 'SENIOR' ? 'Senior Citizen' : statutoryTypeLabel(t) }))}
          value={type}
          onChange={(t) => set({ type: t })}
        />
      ) : null}
      <Text style={styles.summary}>
        {statutoryTypeLabel(type)}: {ruleSummary(config, type)} · {eligibleCountFor(type)} eligible item{eligibleCountFor(type) === 1 ? '' : 's'} in the cart
      </Text>
      <View style={styles.row}>
        <TextField
          label="ID number *"
          value={draft.idNumber}
          onChangeText={(t) => set({ idNumber: t })}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          containerStyle={styles.cell}
        />
        <TextField label={issuerLabel(type)} value={draft.idIssuer} onChangeText={(t) => set({ idIssuer: t })} maxLength={100} containerStyle={styles.cell} />
      </View>
      <View style={styles.row}>
        <TextField label="Cardholder first name *" value={draft.firstName} onChangeText={(t) => set({ firstName: t })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Middle name" value={draft.middleName} onChangeText={(t) => set({ middleName: t })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Last name *" value={draft.lastName} onChangeText={(t) => set({ lastName: t })} maxLength={100} containerStyle={styles.cell} />
      </View>
      <View style={styles.row}>
        <TextField
          label="Birth date (optional)"
          value={draft.birthDate}
          onChangeText={(t) => set({ birthDate: cleanDate(t) })}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          containerStyle={styles.cell}
        />
        {expiryLabel(type) ? (
          <TextField
            label={expiryLabel(type)!}
            value={draft.expiryDate}
            onChangeText={(t) => set({ expiryDate: cleanDate(t) })}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            containerStyle={styles.cell}
          />
        ) : (
          <View style={styles.cell} />
        )}
      </View>
      {type === 'SOLO_PARENT' ? (
        <SoloParentFields
          bookletNumber={draft.bookletNumber}
          kids={draft.children}
          rxInChildName={draft.rxInChildName}
          rxLine={rxLineFor('SOLO_PARENT')}
          onBooklet={(v) => set({ bookletNumber: v })}
          onKids={(v) => set({ children: v })}
          onRxInChildName={(v) => set({ rxInChildName: v })}
        />
      ) : null}
      {touched && problem ? <ErrorText>{problem}</ErrorText> : null}
    </Sheet>
  );
}

const useStyles = makeStyles((_c, t) => ({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  cell: { flex: 1 },
  summary: { ...t.caption, marginVertical: spacing.sm },
}));
