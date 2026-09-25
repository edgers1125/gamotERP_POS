// The recorded sale's official receipt — always shown on screen; printed too when a receipt printer is connected
// (src/printer/printer.ts). Shows whether the sale has reached the server yet and anything the sync flagged.
// Route params: { clientUuid, reprint? } — reprint (e.g. from Sales Today) marks every print REPRINT.
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LocalSale } from '../contracts';
import { Banner, Button } from '../ui/components';
import { colors, font, radius, spacing } from '../ui/theme';
import { localStore } from '../db/localStore';
import { printer } from '../printer/printer';
import { useSyncStatus } from '../sync/syncEngine';
import { formatPeso } from '../sale/money';
import type { SaleStackParamList } from '../sale/navigation';
import { buildReceipt, receiptTextLines } from '../sale/receipt';
import { usePosData } from '../sale/usePosData';
import { ReceiptView } from '../components/sale/ReceiptView';

export type ReceiptScreenProps = NativeStackScreenProps<SaleStackParamList, 'Receipt'>;

export function ReceiptScreen({ navigation, route }: ReceiptScreenProps) {
  const { clientUuid, reprint = false } = route.params;
  const data = usePosData();
  const sync = useSyncStatus();
  const [sale, setSale] = useState<LocalSale | null | undefined>(undefined);
  const [printerReady, setPrinterReady] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [prints, setPrints] = useState(0);
  const [printError, setPrintError] = useState<string | null>(null);

  // Re-read after each sync so the status below follows the outbox.
  useEffect(() => {
    let live = true;
    localStore
      .getSale(clientUuid)
      .then((s) => live && setSale(s))
      .catch(() => live && setSale(null));
    return () => {
      live = false;
    };
  }, [clientUuid, sync.lastSyncAt, sync.pending]);

  useEffect(() => {
    printer.isAvailable().then(setPrinterReady).catch(() => setPrinterReady(false));
  }, []);

  const receipt = useMemo(() => (sale ? buildReceipt(sale, data.bootstrap, data.catalog) : null), [sale, data.bootstrap, data.catalog]);

  // Print once automatically on a fresh sale when a printer is there.
  useEffect(() => {
    if (receipt && printerReady && !reprint && prints === 0) void doPrint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt !== null, printerReady]);

  async function doPrint() {
    if (!receipt || printing) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await printer.printText(receiptTextLines(receipt, { reprint: reprint || prints > 0 }));
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
        <ScrollView style={styles.paperScroll} contentContainerStyle={{ paddingVertical: spacing.md }}>
          <ReceiptView r={receipt} reprint={reprint} voided={!!sale.voided} />
        </ScrollView>

        <View style={styles.side}>
          <Text style={styles.done}>{sale.voided ? 'Sale voided' : 'Sale complete'}</Text>
          <Text style={styles.invoice}>{receipt.invoiceNumber}</Text>
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
          {receipt.missingRequired.length > 0 ? (
            <Banner kind="warning" message={`Missing on the receipt: ${receipt.missingRequired.join(', ')}. Ask a manager to complete the settings.`} style={styles.banner} />
          ) : null}
          {printError ? <Banner kind="danger" message={printError} style={styles.banner} /> : null}

          <View style={{ flex: 1 }} />
          <Button
            title={printerReady ? (prints > 0 || reprint ? 'Reprint receipt' : 'Print receipt') : 'No receipt printer connected'}
            variant="secondary"
            onPress={() => void doPrint()}
            disabled={!printerReady}
            loading={printing}
            style={styles.button}
          />
          <Button title={reprint ? 'Done' : 'New sale'} variant="accent" onPress={reprint ? () => navigation.goBack() : newSale} style={[styles.button, styles.newSale]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  muted: { color: colors.muted, fontSize: font.title },
  body: { flex: 1, flexDirection: 'row', gap: spacing.lg },
  paperScroll: { flex: 3, backgroundColor: '#eceae4', borderRadius: radius.lg },
  side: { flex: 2, minWidth: 320 },
  done: { fontSize: font.title, fontWeight: '700', color: colors.success },
  invoice: { fontSize: font.huge, fontWeight: '800', color: colors.primary, marginBottom: spacing.md },
  change: {
    backgroundColor: colors.success,
    borderRadius: radius.md,
    padding: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  changeLabel: { color: '#fff', fontSize: font.title, fontWeight: '700' },
  changeValue: { color: '#fff', fontSize: 40, fontWeight: '800' },
  total: { fontSize: font.title, color: colors.text, marginBottom: spacing.md },
  banner: { marginBottom: spacing.sm },
  button: { minHeight: 56 },
  newSale: { minHeight: 72, marginTop: spacing.sm },
});
