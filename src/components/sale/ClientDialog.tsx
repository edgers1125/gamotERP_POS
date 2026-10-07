// The sale's client — ONE form that looks like registering a new client, in this order:
//   1. Senior Citizen / PWD discount (first, since the card identifies the person): None / Senior / PWD, then the card.
//   2. Client details: phone, then first / middle / last name.
// Returning customers are recognised along the way (online, via GET /pos/clients — needs the network AND a live online
// cashier token; see canSearchClients):
//   · Senior/PWD ID number → the client on record with that exact card (fills the card from their record);
//   · phone number → the client on record with that exact number (0917…, +63 917…, 917… and any spaces/dashes are the
//     same number — `@shared/phone`);
//   · names → up to 3 "Did you mean…?" suggestions to tap.
// A match fills and locks the details and links the sale to that record (a card on record pre-fills section 1);
// "Not them?" undoes it and that client is never auto-picked again while the form is open.
// Offline nothing is looked up, but the server still links the sale at sync — by phone, and by the card's ID number.
// Only the small "No client details" link skips all of this (the web's "Client prefers not to give contact details").
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PosClient } from '@pos-api/contract';
import { isPhMobile, normalizePhone, samePhone } from '@shared/phone';
import { api } from '../../api/client';
import { ApiError } from '../../contracts';
import { Banner, Button, TextField } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { newClientProblem, newClientUuid, type SaleClient } from '../../sale/cart';
import {
  EMPTY_STATUTORY,
  clientHasStatutory,
  clientName,
  clientStatutoryBlock,
  normalizeIdNumber,
  statutoryClientConflict,
  statutoryProblem,
  statutoryTypeLabel,
  type StatutoryDraft,
  type StatutoryType,
} from '../../sale/statutory';
import { canSearchClients, clientLookupUnavailableReason } from './ClientSearch';
import { ErrorText, HintText, SectionTitle, Segmented, Sheet } from './ui';

type CardChoice = 'NONE' | StatutoryType;
type MatchVia = 'ID' | 'PHONE' | 'NAME';

// ---- phone numbers ---------------------------------------------------------------------------------------------------
// ONE rule, shared with the server and the web (`@shared/phone`): every number is stored, sent and compared in its
// canonical form — 0917 653 0117, +63 917-653-0117 and 9176530117 are all "09176530117".
/** Complete enough to look up: a PH mobile once it's all 11 digits, anything else (landline, foreign) from 7 digits. */
const phoneComplete = (canonical: string) =>
  canonical.startsWith('09') ? isPhMobile(canonical) : canonical.replace(/^\+/, '').length >= 7;
// On screen only the end of a suggested client's number — enough to recognise, not to copy.
function maskedPhone(p: string | null): string {
  const canonical = p ? normalizePhone(p) : '';
  return canonical.length >= 4 ? `•••• ${canonical.slice(-4)}` : 'no phone on record';
}

// ---- lookups -----------------------------------------------------------------------------------------------------------
type LookupState = 'idle' | 'loading' | 'done' | 'error';
interface Lookup {
  rows: PosClient[];
  state: LookupState;
  /** Why the last lookup failed (error state only). */
  error: string | null;
  /** The query `rows` answer (null = nothing searched). */
  answered: string | null;
}
const IDLE: Lookup = { rows: [], state: 'idle', error: null, answered: null };

function lookupErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.code === 'CASHIER_SIGN_IN_REQUIRED') {
      return 'Your online sign-in has expired — sign in with your password again to look up returning clients.';
    }
    if (e.isNetwork) return 'Couldn’t reach the server to look up returning clients — check the connection.';
    return `Couldn’t look up returning clients: ${e.message}`;
  }
  return 'Couldn’t look up returning clients.';
}

/** A debounced client search (online only); null query = don't search. Failures are reported, never swallowed. */
function useClientLookup(query: string | null, enabled: boolean): Lookup {
  const [result, setResult] = useState<Lookup>(IDLE);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!enabled || query === null) {
      setResult(IDLE);
      return;
    }
    setResult((r) => ({ ...r, state: 'loading', error: null }));
    const t = setTimeout(() => {
      api
        .clients(query)
        .then((list) => {
          if (mine === seq.current) setResult({ rows: list, state: 'done', error: null, answered: query });
        })
        .catch((e: unknown) => {
          if (mine === seq.current) setResult({ rows: [], state: 'error', error: lookupErrorMessage(e), answered: query });
        });
    }, 400);
    return () => clearTimeout(t);
  }, [query, enabled]);
  return result;
}

export function ClientDialog({
  visible,
  value,
  statutory,
  eligibleCount,
  online,
  onSave,
  onClose,
}: {
  visible: boolean;
  value: SaleClient;
  statutory: StatutoryDraft | null;
  /** Eligible (sc_pwd_eligible) lines in the cart. */
  eligibleCount: number;
  online: boolean;
  onSave: (client: SaleClient, statutory: StatutoryDraft | null) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const theme = useThemeColors();
  const [noDetails, setNoDetails] = useState(false);
  const [card, setCard] = useState<CardChoice>('NONE');
  const [idNumber, setIdNumber] = useState('');
  const [idIssuer, setIdIssuer] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [phone, setPhone] = useState('');
  const [first, setFirst] = useState('');
  const [middle, setMiddle] = useState('');
  const [last, setLast] = useState('');
  const [matched, setMatched] = useState<PosClient | null>(null);
  const [matchedVia, setMatchedVia] = useState<MatchVia | null>(null);
  /** The card section was filled from the matched client's record (undone with "Not them?"). */
  const [cardFromRecord, setCardFromRecord] = useState(false);
  /** Clients the cashier said "Not them?" to — never auto-picked again while the form is open. */
  const [dismissed, setDismissed] = useState<number[]>([]);
  const [touched, setTouched] = useState(false);
  const searchable = canSearchClients(online);
  const unavailable = clientLookupUnavailableReason(online);

  useEffect(() => {
    if (!visible) return;
    setNoDetails(value.kind === 'WALK_IN');
    setMatched(value.kind === 'EXISTING' ? value.client : null);
    setMatchedVia(null);
    setCardFromRecord(false);
    setDismissed([]);
    const names =
      value.kind === 'EXISTING'
        ? { f: value.client.first_name ?? '', m: value.client.middle_name ?? '', l: value.client.last_name ?? '' }
        : value.kind === 'NEW'
          ? { f: value.firstName, m: value.middleName, l: value.lastName }
          : value.kind === 'WALK_IN'
            ? { f: value.firstName, m: '', l: value.lastName }
            : { f: '', m: '', l: '' };
    setFirst(names.f);
    setMiddle(names.m);
    setLast(names.l);
    setPhone(value.kind === 'EXISTING' ? (value.client.phone_number ?? '') : value.kind === 'NEW' ? value.phone : '');
    setCard(statutory?.type ?? 'NONE');
    setIdNumber(statutory?.idNumber ?? '');
    setIdIssuer(statutory?.idIssuer ?? '');
    setBirthDate(statutory?.birthDate ?? '');
    setExpiryDate(statutory?.expiryDate ?? '');
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const cleanDate = (t: string) => t.replace(/[^0-9-]/g, '').slice(0, 10);

  // Uses a client on record: details filled and locked.
  // · Matched by their Senior/PWD ID → the card section takes their record's card (type, and whatever the cashier hasn't
  //   typed yet: issuer, birth date, PWD expiry). An expired PWD expiry shows as the form's error, to be updated.
  // · Matched otherwise → a valid card on record pre-fills Senior/PWD when it's still None and an item qualifies. An
  //   expired / undated PWD card is left for the cashier (the warning says why).
  function pickClient(c: PosClient, via: MatchVia) {
    setMatched(c);
    setMatchedVia(via);
    setFirst(c.first_name ?? '');
    setMiddle(c.middle_name ?? '');
    setLast(c.last_name ?? '');
    if (c.phone_number) setPhone(c.phone_number);
    if (!clientHasStatutory(c) || eligibleCount === 0) {
      setCardFromRecord(false);
      return;
    }
    const recordExpiry = (c.id_expiry_date ?? '').slice(0, 10);
    if (via === 'ID') {
      setCard(c.statutory_type);
      setIdIssuer((v) => v || (c.statutory_id_issuer ?? ''));
      setBirthDate((v) => v || (c.date_of_birth ?? '').slice(0, 10));
      if (c.statutory_type === 'PWD') setExpiryDate((v) => v || recordExpiry);
      setCardFromRecord(false); // the cashier typed this card — "Not them?" keeps it
    } else if (card === 'NONE' && clientStatutoryBlock(c) === null) {
      setCard(c.statutory_type);
      setIdNumber(c.statutory_id_number);
      setIdIssuer(c.statutory_id_issuer ?? '');
      setBirthDate((c.date_of_birth ?? '').slice(0, 10));
      setExpiryDate(recordExpiry);
      setCardFromRecord(true);
    } else {
      setCardFromRecord(false);
    }
  }

  function clearMatch() {
    if (matched) setDismissed((d) => (d.includes(matched.id) ? d : [...d, matched.id]));
    setMatched(null);
    setMatchedVia(null);
    setFirst('');
    setMiddle('');
    setLast('');
    setPhone('');
    if (cardFromRecord) {
      setCard('NONE');
      setIdNumber('');
      setIdIssuer('');
      setBirthDate('');
      setExpiryDate('');
    }
    setCardFromRecord(false);
  }

  const lookupsOn = searchable && !noDetails;
  // 1. Card ID number → the client on record with exactly that card (same normalisation as the server).
  const idKey = normalizeIdNumber(idNumber);
  const idQuery = card !== 'NONE' && idKey.length >= 4 ? idKey : null;
  const idLookup = useClientLookup(matched ? null : idQuery, lookupsOn);
  const idOnRecord = idLookup.rows.find((c) => clientHasStatutory(c) && normalizeIdNumber(c.statutory_id_number) === idKey) ?? null;
  const idMatch = idOnRecord && !dismissed.includes(idOnRecord.id) ? idOnRecord : null;
  // 2. Phone → the client on record with exactly that number.
  // The server stores and matches the canonical number, so that's what's searched for.
  const phoneCanonical = normalizePhone(phone);
  const phoneQuery = !matched && phoneComplete(phoneCanonical) ? phoneCanonical : null;
  const phoneLookup = useClientLookup(phoneQuery, lookupsOn);
  const phoneOnRecord = phoneLookup.rows.find((c) => samePhone(c.phone_number, phone)) ?? null;
  const phoneMatch = phoneOnRecord && !dismissed.includes(phoneOnRecord.id) ? phoneOnRecord : null;
  // 3. Names → "Did you mean…?" (only while nothing else matched).
  const nameQuery = `${first.trim()} ${last.trim()}`.trim();
  const nameLookup = useClientLookup(
    !matched && !idMatch && !phoneMatch && first.trim().length >= 2 && last.trim().length >= 2 ? nameQuery : null,
    lookupsOn,
  );
  const suggestions = nameLookup.rows.slice(0, 3);

  // An exact ID or phone match is used at once (the cashier can undo it with "Not them?"). Keyed on the ids so a
  // re-render never re-picks; a dismissed client never comes back as a match.
  useEffect(() => {
    if (matched) return;
    if (idMatch) pickClient(idMatch, 'ID');
    else if (phoneMatch) pickClient(phoneMatch, 'PHONE');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idMatch?.id, phoneMatch?.id]);

  // What a lookup says, next to the field it's about (only while there's no match yet).
  const lookupNote = (l: Lookup, query: string | null, found: boolean, notFound: string): string | null => {
    if (matched || !lookupsOn || query === null) return null;
    if (l.state === 'loading') return 'Looking for a returning client…';
    if (l.state === 'error') return l.error;
    if (l.state === 'done' && l.answered === query && !found) return notFound;
    return null;
  };
  const phoneNote = lookupNote(phoneLookup, phoneQuery, phoneOnRecord !== null, 'No client on record with this number — a new client will be added.');
  const idNote = lookupNote(idLookup, idQuery, idOnRecord !== null, 'No client on record with this ID yet — enter their details below.');
  // "Not them?" on an ID match: the server links a sale to whoever holds that card on record, so say so.
  const dismissedIdHolder = !matched && idOnRecord && dismissed.includes(idOnRecord.id) ? idOnRecord : null;

  const draft: StatutoryDraft | null =
    card === 'NONE'
      ? null
      : {
          ...EMPTY_STATUTORY,
          type: card,
          idNumber,
          idIssuer,
          birthDate,
          expiryDate: card === 'PWD' ? expiryDate : '',
          firstName: first,
          middleName: middle,
          lastName: last,
        };
  const cardBlock = matched && card === 'NONE' ? clientStatutoryBlock(matched) : null;

  const problem = useMemo(() => {
    if (noDetails) return null;
    if (!matched) {
      const p = newClientProblem({ firstName: first, lastName: last, phone });
      if (p) return p;
    }
    if (draft) {
      if (eligibleCount === 0) return 'No item in the cart qualifies for the Senior/PWD discount — choose None.';
      return statutoryProblem(draft) ?? statutoryClientConflict(draft, matched);
    }
    return null;
  }, [noDetails, matched, first, last, phone, draft, eligibleCount]);

  function save() {
    if (problem) {
      setTouched(true);
      return;
    }
    if (noDetails) {
      const uuid = value.kind === 'WALK_IN' || value.kind === 'NEW' ? value.clientUuid : newClientUuid();
      onSave({ kind: 'WALK_IN', clientUuid: uuid, firstName: first.trim(), lastName: last.trim() }, null);
    } else if (matched) {
      onSave({ kind: 'EXISTING', client: matched }, draft);
    } else {
      const uuid = value.kind === 'NEW' || value.kind === 'WALK_IN' ? value.clientUuid : newClientUuid();
      // The canonical number, so the server links a later sale to this record by exact phone match at sync.
      onSave(
        { kind: 'NEW', clientUuid: uuid, firstName: first.trim(), middleName: middle.trim(), lastName: last.trim(), phone: normalizePhone(phone) },
        draft,
      );
    }
    onClose();
  }

  function toggleNoDetails() {
    setNoDetails((v) => !v);
    setMatched(null);
    setMatchedVia(null);
    setCardFromRecord(false);
    setCard('NONE');
    setIdNumber('');
    setPhone('');
    setFirst('');
    setMiddle('');
    setLast('');
    setTouched(false);
  }

  const locked = matched !== null;
  const cardSummary =
    card === 'NONE'
      ? 'No Senior/PWD discount on this sale.'
      : `${statutoryTypeLabel(card)} discount on this sale — 20% off ${eligibleCount} eligible item${eligibleCount === 1 ? '' : 's'}, VAT-exempt.`;

  return (
    <Sheet
      visible={visible}
      title="Client"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Use this client" onPress={save} disabled={touched && problem !== null} />
        </>
      }
    >
      {/* Small and on the right: skipping the client is an explicit choice, never the prominent one. */}
      <Pressable accessibilityRole="button" onPress={toggleNoDetails} hitSlop={8} style={styles.skipRow}>
        <Text style={styles.skip}>{noDetails ? 'Enter client details instead' : 'No client details'}</Text>
      </Pressable>

      {noDetails ? (
        <View>
          <Banner kind="info" message="Walk-in client — no contact details are recorded, and no Senior/PWD discount." />
          <SectionTitle>Name (optional)</SectionTitle>
          <View style={styles.row}>
            <TextField label="First name" value={first} onChangeText={setFirst} containerStyle={styles.cell} maxLength={100} />
            <TextField label="Last name" value={last} onChangeText={setLast} containerStyle={styles.cell} maxLength={100} />
          </View>
        </View>
      ) : (
        <View>
          {/* Why returning clients can't be recognised right now — up front, not after the cashier has typed it all. */}
          {unavailable ? (
            <Banner
              kind="info"
              title="Returning clients can’t be looked up"
              message={`${unavailable} The sale is still linked to their record when the device checks in, by phone number or Senior/PWD ID.`}
              style={styles.banner}
            />
          ) : null}

          {/* 1. Senior Citizen / PWD discount — part of this form, first: the card identifies the person. */}
          <View style={[styles.scPanel, card !== 'NONE' && styles.scPanelOn]}>
            <Text style={styles.scTitle}>Senior Citizen / PWD discount</Text>
            {eligibleCount === 0 ? (
              <Text style={styles.scExplain}>
                20% off eligible items, VAT-exempt — but no item in the cart qualifies, so it can’t be used on this sale.
              </Text>
            ) : (
              <>
                <Text style={styles.scExplain}>
                  20% off eligible items, VAT-exempt. Choose the card type first, then enter the ID — the discount applies to
                  this sale.
                </Text>
                <Segmented<CardChoice>
                  options={[
                    { value: 'NONE', label: 'None' },
                    { value: 'SENIOR', label: 'Senior Citizen' },
                    { value: 'PWD', label: 'PWD' },
                  ]}
                  value={card}
                  onChange={(v) => {
                    setCard(v);
                    setCardFromRecord(false);
                  }}
                />
                <Text style={[styles.scStatus, card !== 'NONE' && styles.scStatusOn]}>
                  {card !== 'NONE' ? '✓ ' : ''}
                  {cardSummary}
                </Text>
                {card !== 'NONE' ? (
                  <>
                    <View style={[styles.row, { marginTop: spacing.sm }]}>
                      <TextField
                        label="ID number *"
                        value={idNumber}
                        onChangeText={setIdNumber}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        maxLength={64}
                        containerStyle={styles.cell}
                        editable={!(locked && matchedVia === 'ID')}
                      />
                      <TextField label="Issued by (LGU / OSCA / NCDA)" value={idIssuer} onChangeText={setIdIssuer} maxLength={100} containerStyle={styles.cell} />
                    </View>
                    {idNote ? <HintText>{idNote}</HintText> : null}
                    <View style={styles.row}>
                      <TextField
                        label="Birth date (optional)"
                        value={birthDate}
                        onChangeText={(t) => setBirthDate(cleanDate(t))}
                        placeholder="YYYY-MM-DD"
                        keyboardType="numbers-and-punctuation"
                        containerStyle={styles.cell}
                      />
                      {card === 'PWD' ? (
                        <TextField
                          label="ID expiry date *"
                          value={expiryDate}
                          onChangeText={(t) => setExpiryDate(cleanDate(t))}
                          placeholder="YYYY-MM-DD"
                          keyboardType="numbers-and-punctuation"
                          containerStyle={styles.cell}
                        />
                      ) : (
                        <View style={styles.cell} />
                      )}
                    </View>
                    {dismissedIdHolder ? (
                      <Banner
                        kind="warning"
                        message={`${statutoryTypeLabel(dismissedIdHolder.statutory_type ?? card)} ID ${dismissedIdHolder.statutory_id_number} is on record for ${clientName(dismissedIdHolder)} — a sale with this card is recorded under that client. Check the ID number.`}
                        style={styles.banner}
                      />
                    ) : null}
                    <HintText>Can’t be combined with other discounts. The name on the card is the client’s name below.</HintText>
                  </>
                ) : null}
              </>
            )}
          </View>

          {/* 2. Client details. */}
          <SectionTitle>Client details</SectionTitle>
          {matched ? (
            <View style={styles.match}>
              <View style={{ flex: 1 }}>
                <Text style={styles.matchLabel}>
                  Returning client
                  {matchedVia === 'ID' ? ' · found by Senior/PWD ID' : matchedVia === 'PHONE' ? ' · found by phone number' : ''}
                </Text>
                <Text style={styles.matchName}>
                  {clientName(matched)}
                  {clientHasStatutory(matched) ? ` · ${statutoryTypeLabel(matched.statutory_type)}` : ''}
                </Text>
              </View>
              <Pressable accessibilityRole="button" onPress={clearMatch} hitSlop={8}>
                <Text style={styles.skip}>Not them? Enter a new client</Text>
              </Pressable>
            </View>
          ) : null}
          {cardBlock ? <Banner kind="warning" message={cardBlock} /> : null}
          <TextField
            label={locked ? 'Phone number' : 'Phone number *'}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={30}
            editable={!locked}
          />
          {phoneNote ? <HintText>{phoneNote}</HintText> : null}
          <View style={styles.row}>
            <TextField label="First name *" value={first} onChangeText={setFirst} containerStyle={styles.cell} maxLength={100} editable={!locked} />
            <TextField label="Middle name" value={middle} onChangeText={setMiddle} containerStyle={styles.cell} maxLength={100} editable={!locked} />
            <TextField label="Last name *" value={last} onChangeText={setLast} containerStyle={styles.cell} maxLength={100} editable={!locked} />
          </View>

          {suggestions.length > 0 ? (
            <View>
              <Text style={styles.suggestTitle}>Did you mean…?</Text>
              {suggestions.map((c) => (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  onPress={() => pickClient(c, 'NAME')}
                  style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: theme.primarySoft }]}
                >
                  <Text style={styles.suggestName}>{clientName(c)}</Text>
                  <Text style={styles.suggestMeta}>
                    {maskedPhone(c.phone_number)}
                    {clientHasStatutory(c) ? `  ·  ${statutoryTypeLabel(c.statutory_type)}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      )}

      {touched && problem ? <ErrorText>{problem}</ErrorText> : null}
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  cell: { flex: 1 },
  skipRow: { alignSelf: 'flex-end', marginBottom: spacing.xs },
  skip: { ...t.caption, fontSize: 12, color: c.muted, textDecorationLine: 'underline' },
  banner: { marginBottom: spacing.sm },
  // The Senior/PWD discount block: a tinted panel so it reads as one part of the form, outlined in primary once chosen.
  scPanel: {
    padding: spacing.md,
    marginTop: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
    backgroundColor: c.primaryTint,
  },
  scPanelOn: { borderColor: c.primary },
  scTitle: { ...t.heading, color: c.primary },
  scExplain: { ...t.caption, color: c.text, marginTop: 2, marginBottom: spacing.sm },
  scStatus: { ...t.caption, marginTop: spacing.xs },
  scStatusOn: { ...t.bodyStrong, fontSize: 14, color: c.primary },
  match: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.success,
    backgroundColor: c.successSoft,
  },
  matchLabel: { ...t.overline, fontSize: 11, color: c.success },
  matchName: { ...t.bodyStrong },
  suggestTitle: { ...t.overline, fontSize: 11, marginTop: spacing.sm, marginBottom: spacing.xs },
  suggestion: {
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
    backgroundColor: c.primaryTint,
    justifyContent: 'center',
  },
  suggestName: { ...t.bodyStrong, color: c.primary },
  suggestMeta: { ...t.caption },
}));
