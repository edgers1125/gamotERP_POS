// Senior Citizen / PWD discount (20% off eligible items, VAT-exempt — the shared pricing code does the arithmetic).
// The card details are typed in by hand. A Senior/PWD sale always has a named client: an existing client (online
// search; picking one fills the card from their record) or a new client created from the card's name (offline too —
// the server finds the cardholder by ID number or creates them at sync). A PWD card needs its expiry date and can't
// be used once expired (Manila "today", @shared/business-day). Optional contact details (phone, sex, a complete address)
// can be given for the cardholder's record — for a new client all of them, for an existing one only what their record
// lacks (the server never overwrites); they're sent only when filled.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PosClient } from '@pos-api/contract';
import { Button, TextField } from '../../ui/components';
import { colors, font, spacing } from '../../ui/theme';
import { newClientUuid, type SaleClient } from '../../sale/cart';
import {
  EMPTY_STATUTORY,
  addressStarted,
  draftFromClient,
  statutoryClientConflict,
  statutoryExtrasOffered,
  statutoryProblem,
  withOfferedExtras,
  type ClientSex,
  type StatutoryAddressDraft,
  type StatutoryDraft,
  type StatutoryType,
} from '../../sale/statutory';
import { ClientSearch } from './ClientSearch';
import { ErrorText, HintText, SectionTitle, Segmented, Sheet } from './ui';

type Holder = 'EXISTING' | 'NEW';

export function StatutoryDialog({
  visible,
  value,
  client,
  online,
  eligibleCount,
  onSave,
  onRemove,
  onClose,
}: {
  visible: boolean;
  value: StatutoryDraft | null;
  client: SaleClient;
  online: boolean;
  /** Eligible (sc_pwd_eligible) lines in the cart. */
  eligibleCount: number;
  onSave: (draft: StatutoryDraft, client: SaleClient) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<StatutoryDraft>(value ?? EMPTY_STATUTORY);
  const [holder, setHolder] = useState<Holder>('NEW');
  const [existing, setExisting] = useState<PosClient | null>(null);

  useEffect(() => {
    if (!visible) return;
    const current = client.kind === 'EXISTING' ? client.client : null;
    setExisting(current);
    setHolder(current ? 'EXISTING' : 'NEW');
    if (value) setDraft(value);
    else if (current) setDraft(draftFromClient(current));
    else if (client.kind === 'NEW') setDraft({ ...EMPTY_STATUTORY, firstName: client.firstName, middleName: client.middleName, lastName: client.lastName });
    else setDraft(EMPTY_STATUTORY);
  }, [visible, value, client]);

  const set = (patch: Partial<StatutoryDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setAddress = (patch: Partial<StatutoryAddressDraft>) => setDraft((d) => ({ ...d, address: { ...d.address, ...patch } }));
  const cleanDate = (t: string) => t.replace(/[^0-9-]/g, '').slice(0, 10);

  // The client the extras are for: null = a new client (every extra offered).
  const extrasClient = holder === 'EXISTING' ? existing : null;
  const offered = holder === 'EXISTING' && !existing ? { phone: false, address: false, sex: false } : statutoryExtrasOffered(extrasClient);
  // What would be saved — extras the chosen client doesn't need are dropped (and not checked).
  const effective = withOfferedExtras(draft, extrasClient);

  const problem =
    eligibleCount === 0
      ? 'No item in the cart is eligible for the Senior/PWD discount.'
      : holder === 'EXISTING' && !existing
        ? 'Choose the existing client, or switch to “New client”.'
        : (statutoryProblem(effective) ?? (holder === 'EXISTING' ? statutoryClientConflict(effective, existing) : null));
  const addressOn = addressStarted(draft.address);
  const addr = (field: keyof StatutoryAddressDraft, label: string, required: boolean, maxLength: number) => (
    <TextField
      label={required ? `${label} *` : label}
      value={draft.address[field]}
      onChangeText={(t) => setAddress({ [field]: t })}
      maxLength={maxLength}
      error={required && addressOn && draft.address[field].trim() === '' ? 'Needed for the address' : null}
      containerStyle={styles.cell}
    />
  );

  function save() {
    const saleClient: SaleClient =
      holder === 'EXISTING' && existing
        ? { kind: 'EXISTING', client: existing }
        : {
            kind: 'NEW',
            clientUuid: client.kind === 'NEW' ? client.clientUuid : newClientUuid(),
            firstName: draft.firstName.trim(),
            middleName: draft.middleName.trim(),
            lastName: draft.lastName.trim(),
          };
    onSave(effective, saleClient);
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      title="Senior Citizen / PWD discount"
      onClose={onClose}
      width={760}
      footer={
        <>
          {value ? (
            <Button
              title="Turn off"
              variant="danger"
              onPress={() => {
                onRemove();
                onClose();
              }}
            />
          ) : null}
          <View style={{ flex: 1 }} />
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Apply 20% discount" onPress={save} disabled={problem !== null} />
        </>
      }
    >
      <HintText>
        Eligible items get 20% off and no VAT. It can’t be combined with other discounts — item discounts on eligible items and the sale discount are
        removed. {eligibleCount} eligible item{eligibleCount === 1 ? '' : 's'} in the cart.
      </HintText>

      <SectionTitle>Card</SectionTitle>
      <View style={styles.row}>
        <Segmented<StatutoryType>
          options={[
            { value: 'SENIOR', label: 'Senior Citizen' },
            { value: 'PWD', label: 'PWD' },
          ]}
          value={draft.type}
          onChange={(type) => set({ type })}
        />
        <TextField
          label="ID number"
          value={draft.idNumber}
          onChangeText={(idNumber) => set({ idNumber })}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          containerStyle={styles.cell}
        />
        <TextField label="Issued by (LGU / OSCA / NCDA)" value={draft.idIssuer} onChangeText={(idIssuer) => set({ idIssuer })} maxLength={100} containerStyle={styles.cell} />
      </View>
      <View style={styles.row}>
        <TextField label="First name" value={draft.firstName} onChangeText={(firstName) => set({ firstName })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Middle name" value={draft.middleName} onChangeText={(middleName) => set({ middleName })} maxLength={100} containerStyle={styles.cell} />
        <TextField label="Last name" value={draft.lastName} onChangeText={(lastName) => set({ lastName })} maxLength={100} containerStyle={styles.cell} />
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
        {draft.type === 'PWD' ? (
          <TextField
            label="ID expiry date (required for PWD)"
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

      <SectionTitle>Cardholder (the sale’s client)</SectionTitle>
      <Segmented<Holder>
        options={[
          { value: 'EXISTING', label: 'Existing client' },
          { value: 'NEW', label: 'New client' },
        ]}
        value={holder}
        onChange={setHolder}
      />
      <View style={{ height: spacing.sm }} />
      {holder === 'EXISTING' ? (
        <ClientSearch
          online={online}
          selectedId={existing?.id ?? null}
          onPick={(c) => {
            setExisting(c);
            setDraft((d) => draftFromClient(c, d));
          }}
        />
      ) : (
        <HintText>A client is created from the card’s name — or, if someone already holds this ID number, the sale is recorded under them.</HintText>
      )}
      {existing && holder === 'EXISTING' ? <Text style={styles.picked}>Selected: {[existing.first_name, existing.last_name].filter(Boolean).join(' ')}</Text> : null}

      {offered.phone || offered.sex || offered.address ? (
        <>
          <SectionTitle>Contact details (optional)</SectionTitle>
          <HintText>
            {holder === 'NEW'
              ? 'Saved on the new client’s record if given. An address must be complete (* fields), or left blank.'
              : 'Their record doesn’t have these yet — saved only where it has none. An address must be complete (* fields), or left blank.'}
          </HintText>
          <View style={{ height: spacing.sm }} />
          {offered.phone || offered.sex ? (
            <View style={styles.row}>
              {offered.phone ? (
                <TextField
                  label="Phone number"
                  value={draft.phone}
                  onChangeText={(phone) => set({ phone })}
                  keyboardType="phone-pad"
                  maxLength={30}
                  containerStyle={styles.cell}
                />
              ) : null}
              {offered.sex ? (
                <View style={[styles.cell, styles.field]}>
                  <Text style={styles.label}>Sex</Text>
                  <Segmented<ClientSex | ''>
                    options={[
                      { value: '', label: 'Not given' },
                      { value: 'MALE', label: 'Male' },
                      { value: 'FEMALE', label: 'Female' },
                      { value: 'OTHER', label: 'Other' },
                    ]}
                    value={draft.sex}
                    onChange={(sex) => set({ sex })}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {offered.address ? (
            <>
              <View style={styles.row}>
                {addr('line1', 'Address line 1', true, 255)}
                {addr('line2', 'Address line 2', false, 255)}
              </View>
              <View style={styles.row}>
                {addr('barangay', 'Barangay', false, 255)}
                {addr('city', 'City / municipality', true, 255)}
              </View>
              <View style={styles.row}>
                {addr('province', 'Province', true, 255)}
                {addr('region', 'Region', false, 255)}
                {addr('postalCode', 'Postal code', true, 20)}
              </View>
              {addressOn ? <Button title="Clear address" variant="ghost" onPress={() => set({ address: EMPTY_STATUTORY.address })} /> : null}
            </>
          ) : null}
        </>
      ) : null}

      {problem ? <ErrorText>{problem}</ErrorText> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  cell: { flex: 1 },
  picked: { marginTop: spacing.sm, fontSize: font.body, fontWeight: '600', color: colors.primary },
  field: { marginBottom: spacing.md },
  label: { fontSize: font.small, color: colors.muted, marginBottom: spacing.xs, fontWeight: '600' },
});
