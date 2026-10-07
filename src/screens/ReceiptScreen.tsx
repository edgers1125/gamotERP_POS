// The recorded sale's official receipt — always shown on screen; printed too when a receipt printer is connected
// (src/printer/printer.ts). Shows whether the sale has reached the server yet and anything the sync flagged.
// Route params: { clientUuid, reprint? } — reprint (e.g. from Sales Today) marks every print REPRINT.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LocalSale } from '../contracts';
import { Banner, Button } from '../ui/components';
import { makeStyles } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';
import { localStore } from '../db/localStore';
import { customerDisplay } from '../display/customerDisplay';
import { printer } from '../printer/printer';
import { useSyncStatus } from '../sync/syncEngine';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { buildReceipt, loadReceiptSnapshot, receiptTextLines } from '../sale/receipt';
import { receiptLogoUri } from '../sale/receiptAssets';
import { usePosData } from '../sale/usePosData';
import { ReceiptView } from '../components/sale/ReceiptView';

export type ReceiptScreenProps = NativeStackScreenProps<SaleStackParamList, 'Receipt'>;

export function ReceiptScreen({ navigation, route }: ReceiptScreenProps) {
  const styles = useStyles();
  const { clientUuid, reprint = false } = route.params;
  const data = usePosData();
  const sync = useSyncStatus();
  const [sale, setSale] = useState<LocalSale | null | undefined>(undefined);
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [printerReady, setPrinterReady] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [prints, setPrints] = useState(0);
  const [printError, setPrintError] = useState<string | null>(null);

  // Re-read after each sync so the status below follows the outbox.
  useEffect(() => {
    let live = true;
    // The sale's receipt snapshot (names / flags as sold) is loaded first, so a reprint after a restart matches.
    Promise.all([localStore.getSale(clientUuid), loadReceiptSnapshot(clientUuid)])
      .then(([s]) => live && setSale(s))
      .catch(() => live && setSale(null));
    return () => {
      live = false;
    };
  }, [clientUuid, sync.lastSyncAt, sync.pending]);

  useEffect(() => {
    printer.isAvailable().then(setPrinterReady).catch(() => setPrinterReady(false));
  }, []);

  // The receipt logo from the device cache (downloaded by the sync engine when Settings → Receipts changes it).
  useEffect(() => {
    let live = true;
    receiptLogoUri(data.bootstrap)
      .then((uri) => live && setLogoUri(uri))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [data.bootstrap]);

  const built = useMemo(
    () => (sale ? buildReceipt(sale, data.bootstrap, data.catalog, { logoUri, reprint: reprint || prints > 0 }) : null),
    [sale, data.bootstrap, data.catalog, logoUri, reprint, prints],
  );
  const receipt = built?.data ?? null;
  // Like the web (which refuses to render one), a receipt that doesn't add up is never printed.
  const reconcileError = built && built.errors.length > 0 ? built.errors[0]! : null;

  // Customer display: "Thank you" once for a fresh sale (never for a reprint or a voided sale).
  const thanked = useRef(false);
  useEffect(() => {
    if (!receipt || !sale || reprint || sale.voided || thanked.current) return;
    thanked.current = true;
    customerDisplay.showThankYou({ total: receipt.total, change: receipt.change, invoiceNumber: receipt.invoice_number ?? '' });
  }, [receipt, sale, reprint]);

  // Print once automatically on a fresh sale when a printer is there.
  useEffect(() => {
    if (receipt && printerReady && !reprint && prints === 0 && !reconcileError) void doPrint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt !== null, printerReady]);

  async function doPrint() {
    if (!receipt || !sale || printing || reconcileError) return;
    setPrinting(true);
    setPrintError(null);
    try {
      // Every print after the first is a REPRINT (the builder marks it from printCount).
      const printed = buildReceipt(sale, data.bootstrap, data.catalog, { logoUri, reprint: reprint || prints > 0 }).data;
      await printer.printText(receiptTextLines(printed));
      setPrints((n) => n + 1);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : 'Printing failed.');
    } finally {
      setPrinting(false);
    }
  }

  function newSale() {
    if (navigation.canGoBack()) navigation.popTo('Sell');
    else navigation.replace('Sell');
  }

  if (sale === undefined) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.muted}>Loading the receipt…</Text>
      </View>
    );
  }
  if (sale === null || !receipt) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.muted}>This sale isn’t on this device.</Text>
        <Button title="New sale" onPress={newSale} />
      </View>
    );
  }

  const result = sale.sync_result;
  const status =
    sale.sync_status === 'PENDING'
      ? sync.online
        ? 'Sending to the server…'
        : 'Saved on this device — it’s sent when the connection is back.'
      : sale.sync_status === 'RECORDED'
        ? `Recorded on the server${result?.reference ? ` as ${result.reference}` : ''}.`
        : `The server couldn’t record this sale${result?.error ? `: ${result.error}` : ''} — a manager will review it.`;

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <ScrollView style={styles.paperScroll} contentContainerStyle={styles.paperContent}>
          <ReceiptView data={receipt} />
        </ScrollView>

        <View style={styles.side}>
          <Text style={styles.done}>{sale.voided ? 'Sale voided' : 'Sale complete'}</Text>
          <Text style={styles.invoice}>{receipt.invoice_number}</Text>
          {receipt.change !== null ? (
            <View style={styles.change}>
              <Text style={styles.changeLabel}>Change</Text>
              <Text style={styles.changeValue}>{formatPeso(receipt.change)}</Text>
            </View>
          ) : null}
          <Text style={styles.total}>Total {formatPeso(receipt.total)}</Text>

          <Banner
            kind={sale.sync_status === 'REJECTED' ? 'danger' : sale.sync_status === 'RECORDED' ? 'success' : 'info'}
            message={status}
            style={styles.banner}
          />
          {result?.stock_status === 'OVERSOLD' ? (
            <Banner kind="warning" message="The branch’s recorded stock didn’t cover this sale, so it was saved as Oversold — post the stock once it’s received." style={styles.banner} />
          ) : null}
          {result?.exceptions?.length ? (
            <Banner kind="warning" title="Flagged for review" message={result.exceptions.map((x) => x.message).join('\n')} style={styles.banner} />
          ) : null}
          {receipt.missing_required.length > 0 ? (
            <Banner
              kind="warning"
              message={`This receipt is missing required details: ${receipt.missing_required.join(', ')}. They print as “—” until set in Settings → Receipts (or on the POS terminal).`}
              style={styles.banner}
            />
          ) : null}
          {reconcileError ? (
            <Banner kind="danger" message={`This receipt does not add up (${reconcileError}) — it won’t be printed. Please report it.`} style={styles.banner} />
          ) : null}
          {printError ? <Banner kind="danger" message={printError} style={styles.banner} /> : null}

          <View style={styles.spacer} />
          <Button
            title={printerReady ? (prints > 0 || reprint ? 'Reprint receipt' : 'Print receipt') : 'No receipt printer connected'}
            variant="secondary"
            onPress={() => void doPrint()}
            disabled={!printerReady || !!reconcileError}
            loading={printing}
            style={styles.button}
          />
          <Button title={reprint ? 'Done' : 'New sale'} variant="primary" onPress={reprint ? () => navigation.goBack() : newSale} style={[styles.button, styles.newSale]} />
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  muted: { ...t.heading, color: c.muted },
  body: { flex: 1, flexDirection: 'row', gap: spacing.lg },
  // The receipt paper (ReceiptView) sits on a muted tray, like a print preview.
  paperScroll: {
    flex: 3,
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  paperContent: { paddingVertical: spacing.lg },
  side: {
    flex: 2,
    minWidth: 320,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.xl,
    ...shadow.card,
  },
  done: { ...t.title, color: c.success },
  invoice: { ...t.display, color: c.primary, fontVariant: ['tabular-nums'], marginBottom: spacing.lg },
  change: {
    backgroundColor: c.successSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.success,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  changeLabel: { ...t.heading, color: c.success },
  changeValue: { ...t.display, fontSize: 40, color: c.success, fontVariant: ['tabular-nums'] },
  total: { ...t.heading, fontVariant: ['tabular-nums'], marginBottom: spacing.lg },
  banner: { marginBottom: spacing.sm },
  spacer: { flex: 1, minHeight: spacing.lg },
  // Same height as the checkout actions on Sell and Payment.
  button: { minHeight: 56 },
  newSale: { marginTop: spacing.sm },
}));
