// The Rx step of a sale that has a prescription-only line (docs/plans/pos-rx-step.md, "Screens expected"): between Sell
// and Payment. The Charge button on Sell comes here instead of Payment while the cart needs a prescription.
//   * Fill an open prescription of the (existing) client — ONLINE only — or record a NEW one (offline too: the doctors
//     list is cached on the tablet, src/sale/doctors.ts). The draft lives in the cart (`cart.rx`), so Back keeps it.
//   * Issues (src/sale/prescription.ts localRxIssues; online the server's check has the last word) show under their
//     field — only after the first "Continue to payment" press, so nothing nags while typing.
//   * Continue → `checkCartPrescription`: ok / unchecked (offline — the server re-checks at sync) → Payment.
// Layout: two columns from 720dp (left: choice + doctor, right: details); stacked below that.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PosOpenPrescription, PosPrescriptionDoctor, PosRxIssue } from '@pos-api/contract';
import { api } from '../api/client';
import { cashierSession, useCashier } from '../auth/cashierSession';
import { Banner, Button, TextField } from '../ui/components';
import { makeStyles } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';
import { useSyncStatus } from '../sync/syncEngine';
import { rxLinesOf, useCart } from '../sale/cart';
import { checkCartPrescription, localPrescriptionIssues, saleClientName } from '../sale/checkout';
import { doctorsCache, useDoctors } from '../sale/doctors';
import type { SaleStackParamList } from '../sale/navigation';
import { cartNeedsRx, newRxDraft, rxIssueField, rxModelsOf, rxPatientOf, rxSaleDay, withCartModels, type RxNewDraft } from '../sale/prescription';
import { formatAge, errorMessage } from '../components/shell/format';
import { DoctorPicker } from '../components/rx/DoctorPicker';
import { AddDoctorDialog } from '../components/rx/AddDoctorDialog';
import { FillMissingDialog, MISSING_LABELS } from '../components/rx/FillMissingDialog';
import { OpenPrescriptionList } from '../components/rx/OpenPrescriptionList';
import { Chip, HintText, SectionTitle, StatusBadge } from '../components/sale/ui';

export type PrescriptionScreenProps = NativeStackScreenProps<SaleStackParamList, 'Prescription'>;

type Choice = 'FILL' | 'NEW';

export function PrescriptionScreen({ navigation }: PrescriptionScreenProps) {
  const styles = useStyles();
  const cart = useCart();
  const sync = useSyncStatus();
  const cashier = useCashier((s) => s.cashier);
  const doctors = useDoctors();
  const wide = useWindowDimensions().width >= 720;

  const online = sync.online && cashierSession.isOnlineSession();
  const blocked = sync.blockedReason ?? (cashier ? null : 'Sign in as a cashier to sell.');
  const lines = useMemo(() => rxLinesOf(cart), [cart.lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsRx = cartNeedsRx(lines);
  const { models } = useMemo(() => rxModelsOf(lines), [lines]);
  const dangerous = models.some((m) => m.dangerous);
  const patient = rxPatientOf(cart.client, cart.statutory);
  const rx = cart.rx;
  const [choice, setChoice] = useState<Choice | null>(rx ? rx.mode : null);

  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<PosRxIssue[]>([]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filling, setFilling] = useState(false);
  const [keptNote, setKeptNote] = useState<string | null>(null);

  // Open prescriptions of the client (fetched online, during this sale).
  const [openRows, setOpenRows] = useState<PosOpenPrescription[] | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const clientId = cart.client.kind === 'EXISTING' ? cart.client.client.id : null;

  // The doctors list: cached copy first, then a refresh when a cashier is signed in online (never blocks the screen).
  useEffect(() => {
    void doctorsCache.load().then(() => {
      if (cashierSession.isOnlineSession()) void doctorsCache.refresh();
    });
  }, []);

  // A NEW draft follows the cart's Rx models; the Rx lines going away drops the draft.
  useEffect(() => {
    if (!needsRx) {
      if (useCart.getState().rx) useCart.getState().setRx(null);
      return;
    }
    if (choice !== 'NEW') return;
    const cur = useCart.getState().rx;
    if (!cur || cur.mode !== 'NEW') {
      useCart.getState().setRx(newRxDraft(models, rxSaleDay()));
      return;
    }
    const next = withCartModels(cur, models);
    if (next !== cur) useCart.getState().setRx(next);
  }, [choice, models, needsRx]);

  const loadOpen = useCallback(async () => {
    if (clientId === null) return;
    setOpenLoading(true);
    setOpenError(null);
    try {
      setOpenRows(await api.openPrescriptions(clientId));
    } catch (e) {
      setOpenRows(null);
      setOpenError(errorMessage(e, 'The open prescriptions couldn’t be loaded.'));
    } finally {
      setOpenLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    setOpenRows(null);
    setOpenError(null);
    if (choice === 'FILL' && online && clientId !== null) void loadOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, clientId, online]);

  // Edits clear the server's earlier answer — it was about the old draft.
  useEffect(() => {
    setServerIssues([]);
    setCheckError(null);
  }, [cart.rx, cart.client]);

  function chooseFill() {
    setChoice('FILL');
    if (useCart.getState().rx?.mode === 'NEW') useCart.getState().setRx(null);
  }

  function chooseNew() {
    setChoice('NEW');
  }

  const draft: RxNewDraft | null = rx?.mode === 'NEW' ? rx : null;
  function patch(p: Partial<RxNewDraft>) {
    const cur = useCart.getState().rx;
    if (cur?.mode === 'NEW') useCart.getState().setRx({ ...cur, ...p });
  }

  const doctor: PosPrescriptionDoctor | null = draft && draft.doctorId !== null ? (doctors.items.find((d) => d.id === draft.doctorId) ?? null) : null;

  // ---- issues -----------------------------------------------------------------------------------------------------
  const liveIssues = useMemo(
    () => (attempted && needsRx ? localPrescriptionIssues(cart) : []),
    [attempted, needsRx, cart.lines, cart.client, cart.statutory, cart.rx, doctors.items], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const issues = liveIssues.length > 0 ? liveIssues : attempted ? serverIssues : [];
  const placed = issues.map((issue) => ({ issue, ...rxIssueField(issue, lines) }));
  const inline = (field: string) => placed.filter((p) => p.field === field && draft !== null).map((p) => p.issue.message);
  const quantityErrors = (modelId: number) =>
    placed.filter((p) => p.field === 'quantity' && p.modelId === modelId && draft !== null).map((p) => p.issue.message).join('\n') || null;
  const bannerIssues = placed.filter(
    (p) =>
      draft === null ||
      p.field === 'client' ||
      p.field === 'general' ||
      p.field === 'open' ||
      (p.field === 'quantity' && (p.modelId === null || !models.some((m) => m.modelId === p.modelId))),
  );
  const clientIssue = bannerIssues.some((p) => p.field === 'client');
  const errorOf = (field: string): string | null => inline(field).join('\n') || null;

  async function onContinue() {
    if (busy || blocked) return;
    setAttempted(true);
    setBusy(true);
    setCheckError(null);
    try {
      const out = await checkCartPrescription(useCart.getState(), sync.online);
      if (out.kind === 'ok' || out.kind === 'unchecked') {
        setServerIssues([]);
        navigation.navigate('Payment');
      } else if (out.kind === 'issues') {
        setServerIssues(out.local ? [] : out.issues);
      } else {
        setCheckError(out.message);
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- render -----------------------------------------------------------------------------------------------------
  if (cart.lines.length === 0 || !needsRx) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.emptyText}>{cart.lines.length === 0 ? 'The cart is empty.' : 'This sale has no prescription item.'}</Text>
        <Button title="Back to the till" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  const modelSummary = (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Prescription for this sale</Text>
      <Text style={styles.line}>Patient: {saleClientName(cart) ?? 'Not chosen yet'}</Text>
      {models.map((m) => (
        <View key={m.modelId} style={styles.modelRow}>
          <Text style={styles.modelName} numberOfLines={2}>
            {m.modelName}
          </Text>
          <Text style={styles.line}>{m.pieces} pc</Text>
          {m.dangerous ? <StatusBadge label="DD" tone="warning" /> : null}
        </View>
      ))}
    </View>
  );

  const cacheLine =
    doctors.savedAt && doctors.items.length > 0 ? `Doctors list on this tablet: ${doctors.items.length}, saved ${formatAge(doctors.savedAt)}.` : null;

  const choicePanel = (
    <View style={styles.panel}>
      <SectionTitle>How is this sale covered?</SectionTitle>
      <View style={styles.chips}>
        <Chip label="Fill an open prescription" selected={choice === 'FILL'} onPress={chooseFill} />
        <Chip label="New prescription" selected={choice === 'NEW'} onPress={chooseNew} />
      </View>
    </View>
  );

  const fillPanel =
    choice === 'FILL' ? (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Open prescriptions</Text>
        {!online ? (
          <Text style={styles.warn}>Filling an open prescription needs a connection — record a new one or wait.</Text>
        ) : clientId === null ? (
          <HintText>{cart.client.kind === 'NEW' ? 'A new client has no open prescriptions.' : 'Choose the patient on the till first.'}</HintText>
        ) : openLoading ? (
          <HintText>Loading open prescriptions…</HintText>
        ) : openError ? (
          <>
            <Text style={styles.errorText}>{openError}</Text>
            <Button title="Try again" variant="secondary" compact onPress={() => void loadOpen()} style={styles.gap} />
          </>
        ) : openRows && openRows.length === 0 ? (
          <HintText>No open prescriptions for this client.</HintText>
        ) : openRows ? (
          <OpenPrescriptionList
            rows={openRows}
            selectedId={rx?.mode === 'FILL' ? rx.prescription.id : null}
            onPick={(p) => useCart.getState().setRx({ mode: 'FILL', prescription: p, clientId: clientId })}
          />
        ) : null}
      </View>
    ) : null;

  const doctorPanel =
    choice === 'NEW' && draft ? (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Prescribing doctor</Text>
        {doctors.refreshing ? <HintText>Updating doctors…</HintText> : null}
        {cacheLine ? <HintText>{cacheLine}</HintText> : null}
        {doctors.items.length === 0 && !online && !doctors.refreshing ? (
          <Text style={styles.warn}>No doctors downloaded yet — connect once with a cashier signed in online.</Text>
        ) : null}
        {draft.doctorId === null ? (
          <DoctorPicker
            doctors={doctors.items}
            truncated={doctors.truncated}
            online={online}
            onPick={(d) => {
              setKeptNote(null);
              patch({ doctorId: d.id });
            }}
            onAdd={() => setAdding(true)}
          />
        ) : doctor ? (
          <View>
            <View style={styles.doctorCard}>
              <Text style={styles.doctorName}>{doctor.name}</Text>
              <Text style={styles.line}>Clinic: {doctor.clinic ?? '—'}</Text>
              <Text style={styles.line}>PRC: {doctor.license_number ?? '—'}</Text>
              <Text style={styles.line}>PTR: {doctor.ptr_number ?? '—'}</Text>
              <Text style={styles.line}>S2: {doctor.s2_license_number ?? '—'}</Text>
              <Text style={styles.line}>Specialty: {doctor.specialty ?? '—'}</Text>
              {!doctor.usable ? <Text style={styles.warn}>No PRC licence on file — fill it in below to use this doctor.</Text> : null}
            </View>
            <View style={styles.buttonRow}>
              <Button
                title="Change"
                variant="secondary"
                compact
                onPress={() => {
                  setKeptNote(null);
                  patch({ doctorId: null });
                }}
              />
              {doctor.missing.length > 0 ? (
                <Button title="Fill in missing details" variant="secondary" compact disabled={!online} onPress={() => setFilling(true)} />
              ) : null}
            </View>
            {doctor.missing.length > 0 && !online ? (
              <HintText>Missing: {doctor.missing.map((k) => MISSING_LABELS[k]).join(', ')}. Filling them in needs a connection.</HintText>
            ) : null}
            {keptNote ? <HintText>{keptNote}</HintText> : null}
          </View>
        ) : (
          <View>
            <Text style={styles.warn}>This doctor is no longer on the doctors list.</Text>
            <Button title="Change" variant="secondary" compact onPress={() => patch({ doctorId: null })} style={styles.gap} />
          </View>
        )}
        {errorOf('doctor') ? <Text style={styles.errorText}>{errorOf('doctor')}</Text> : null}
      </View>
    ) : null;

  const detailsPanel =
    choice === 'NEW' && draft ? (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Prescription details</Text>
        <TextField
          label="Prescription date"
          value={draft.date}
          onChangeText={(v) => patch({ date: v.trim() })}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          maxLength={10}
          error={errorOf('date')}
        />
        {models.map((m) => (
          <TextField
            key={m.modelId}
            label={`Quantity prescribed (pieces) — ${m.modelName}`}
            value={draft.quantities[m.modelId] ?? ''}
            onChangeText={(v) => patch({ quantities: { ...draft.quantities, [m.modelId]: v.replace(/[^0-9]/g, '') } })}
            keyboardType="number-pad"
            maxLength={7}
            hint={`In this sale: ${m.pieces} piece${m.pieces === 1 ? '' : 's'}`}
            error={quantityErrors(m.modelId)}
          />
        ))}
        {doctor && doctor.ptr_number === null ? (
          <TextField label="Doctor’s PTR no. (optional)" value={draft.ptr} onChangeText={(v) => patch({ ptr: v })} maxLength={30} error={errorOf('ptr')} />
        ) : null}
        {dangerous ? (
          <>
            {doctor && doctor.s2_license_number === null ? (
              <TextField label="Doctor’s S2 licence no." value={draft.s2} onChangeText={(v) => patch({ s2: v })} maxLength={30} error={errorOf('s2')} />
            ) : null}
            <TextField label="Prescription form serial no." value={draft.serial} onChangeText={(v) => patch({ serial: v })} maxLength={40} error={errorOf('serial')} />
            <TextField
              label="Patient address"
              value={draft.patientAddress}
              onChangeText={(v) => patch({ patientAddress: v })}
              maxLength={300}
              hint={patient.hasAddress ? 'Leave blank to use the address on record' : null}
              error={errorOf('address')}
            />
          </>
        ) : null}
      </View>
    ) : rx?.mode === 'FILL' ? (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Filling {rx.prescription.reference}</Text>
        <Text style={styles.line}>
          {rx.prescription.prescriber_name} · written {rx.prescription.prescription_date} · valid until {rx.prescription.valid_until}
        </Text>
        {rx.prescription.items.map((it) => (
          <Text key={it.product_model_id} style={styles.line}>
            {it.model_name}: {it.quantity_remaining} of {it.quantity_prescribed} left{it.is_dangerous_drug ? ' · DD' : ''}
          </Text>
        ))}
      </View>
    ) : choice === null ? (
      <View style={styles.panel}>
        <HintText>Choose how this sale is covered — an open prescription of the client, or a new one.</HintText>
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      {blocked ? <Banner kind="danger" title="Selling is paused" message={blocked} style={styles.banner} /> : null}
      {checkError ? <Banner kind="danger" message={checkError} style={styles.banner} /> : null}
      {bannerIssues.length > 0 ? (
        <Banner
          kind="danger"
          title="The prescription can’t be used yet"
          message={bannerIssues.map((p) => p.issue.message).join('\n')}
          actionLabel={clientIssue ? 'Back to the till' : undefined}
          onAction={clientIssue ? () => navigation.goBack() : undefined}
          style={styles.banner}
        />
      ) : null}
      <View style={styles.headerRow}>
        <Button title="‹ Back to cart" variant="ghost" compact onPress={() => navigation.goBack()} disabled={busy} />
        {choice === 'NEW' && doctors.refreshing ? <Text style={styles.updating}>Updating doctors…</Text> : null}
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.columns, !wide && styles.columnsStacked]}>
          <View style={[styles.col, wide && styles.colWide]}>
            {modelSummary}
            {choicePanel}
            {fillPanel}
            {doctorPanel}
          </View>
          <View style={[styles.col, wide && styles.colWide]}>{detailsPanel}</View>
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Button title="Continue to payment" variant="primary" onPress={() => void onContinue()} disabled={!!blocked} loading={busy} style={styles.continue} />
      </View>

      <AddDoctorDialog
        visible={adding}
        onClose={() => setAdding(false)}
        onPicked={(id) => {
          setAdding(false);
          setKeptNote(null);
          patch({ doctorId: id });
        }}
      />
      <FillMissingDialog
        visible={filling}
        doctor={doctor}
        onClose={() => setFilling(false)}
        onDone={(res) => {
          setFilling(false);
          setKeptNote(res.kept.length > 0 ? `Already on file, not changed: ${res.kept.map((k) => MISSING_LABELS[k as keyof typeof MISSING_LABELS] ?? k).join(', ')}.` : null);
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  emptyText: { ...t.heading, color: c.muted },
  flex: { flex: 1 },
  banner: { marginBottom: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  updating: { ...t.caption, color: c.muted },
  scroll: { paddingBottom: spacing.lg },
  columns: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start' },
  columnsStacked: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.md },
  col: { gap: spacing.md },
  colWide: { flex: 1 },
  panel: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  panelTitle: { ...t.heading, marginBottom: spacing.sm },
  line: { ...t.body },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  modelName: { ...t.body, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  doctorCard: { backgroundColor: c.surfaceMuted, borderRadius: radius.md, padding: spacing.md, gap: 2 },
  doctorName: { ...t.subtitle },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  warn: { ...t.body, color: c.warning, backgroundColor: c.warningSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  errorText: { ...t.caption, color: c.danger, marginTop: spacing.xs },
  gap: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  footer: { paddingTop: spacing.md, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: c.border, alignItems: 'flex-end' },
  continue: { minHeight: 56, minWidth: 260 },
}));
