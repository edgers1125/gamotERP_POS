// The official receipt on screen (docs/plans/sales-receipt.md layout) — black on white like the printed one; brand
// colours stay in the surrounding chrome. Built from `buildReceipt` (src/sale/receipt.ts).
import { StyleSheet, Text, View } from 'react-native';
import type { ReceiptModel } from '../../sale/receipt';
import { formatPeso } from '../../sale/money';

const MONO = 'monospace';

function Row({ left, right, bold }: { left: string; right: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.text, styles.flex, bold && styles.bold]}>{left}</Text>
      <Text style={[styles.text, bold && styles.bold]}>{right}</Text>
    </View>
  );
}

const Rule = () => <View style={styles.rule} />;
const blank = '______________________';

export function ReceiptView({ r, reprint, voided }: { r: ReceiptModel; reprint?: boolean; voided?: boolean }) {
  return (
    <View style={[styles.paper, { width: r.paperWidth === 'MM_58' ? 300 : 400 }]}>
      {voided ? <Text style={styles.mark}>*** VOID ***</Text> : null}
      {reprint ? <Text style={styles.mark}>*** REPRINT ***</Text> : null}
      <Text style={[styles.center, styles.bold, styles.title]}>{r.businessName}</Text>
      {r.fixedLines.map((l, i) => (
        <Text key={`f${i}`} style={[styles.text, styles.center]}>
          {l}
        </Text>
      ))}
      {r.customLines.map((l, i) => (
        <Text key={`c${i}`} style={[styles.text, styles.center]}>
          {l}
        </Text>
      ))}
      <Rule />
      <Row left={r.saleTypeLabel} right={r.customerTypeLabel ?? ''} bold />
      {r.terminalLabel || r.customerName ? <Row left={r.terminalLabel ?? ''} right={r.customerName ?? ''} /> : null}
      <Rule />
      <View style={styles.row}>
        <Text style={[styles.text, styles.bold, styles.flex]}>Item</Text>
        <Text style={[styles.text, styles.bold, styles.qty]}>Qty</Text>
        <Text style={[styles.text, styles.bold, styles.price]}>Price</Text>
        <Text style={[styles.text, styles.bold, styles.amount]}>Amount</Text>
      </View>
      {r.items.map((it, i) => (
        <View key={i} style={styles.row}>
          <Text style={[styles.text, styles.flex]}>{it.name}</Text>
          <Text style={[styles.text, styles.qty]}>{it.quantity}</Text>
          <Text style={[styles.text, styles.price]}>{it.unitPrice}</Text>
          <Text style={[styles.text, styles.amount]}>
            {it.amount} {it.vatFlag}
          </Text>
        </View>
      ))}
      {r.adjustments.map((a, i) => (
        <Row key={`a${i}`} left={a.label} right={formatPeso(a.amount)} />
      ))}
      <Rule />
      <Row left={`TOTAL: ${r.itemCount} Item${r.itemCount === 1 ? '' : 's'}`} right={formatPeso(r.total)} bold />
      {r.payments.map((p, i) => (
        <Row key={`p${i}`} left={p.reference ? `${p.label} ref ${p.reference}` : p.label} right={formatPeso(p.amount)} />
      ))}
      {r.cashReceived !== null ? (
        <>
          <Row left="Cash received" right={formatPeso(r.cashReceived)} />
          <Row left="CHANGE" right={formatPeso(r.change ?? '0')} bold />
        </>
      ) : null}
      <Rule />
      <Row left="VAT Sales" right={formatPeso(r.vat.vatSales)} />
      <Row left="Non-VAT Sales" right={formatPeso(r.vat.nonVatSales)} />
      <Row left="Zero-Rated Sales" right={formatPeso(r.vat.zeroRatedSales)} />
      <Row left="Total Sales" right={formatPeso(r.vat.totalSales)} />
      <Row left="Total VAT" right={formatPeso(r.vat.totalVat)} />
      <Row left="Total Amount" right={formatPeso(r.vat.totalAmount)} />
      <Row left="Total Discount" right={formatPeso(r.vat.totalDiscount)} />
      <Row left="VAT Exemption" right={formatPeso(r.vat.vatExemption)} />
      <Rule />
      <Row left="Trans No." right={r.invoiceNumber} bold />
      <Row left="Date" right={r.issuedAtDisplay} />
      <Text style={[styles.text, styles.center, styles.bold, { marginTop: 8 }]}>{r.titleLine}</Text>
      {r.messageLines.map((l, i) => (
        <Text key={`m${i}`} style={[styles.text, styles.center]}>
          {l}
        </Text>
      ))}
      <Rule />
      <Text style={styles.text}>Customer: {r.customerBlock.name ?? blank}</Text>
      <Text style={styles.text}>Address: {r.customerBlock.address ?? blank}</Text>
      <Text style={styles.text}>TIN: {r.customerBlock.tin ?? blank}</Text>
      <Text style={styles.text}>
        {r.customerBlock.idLabel}: {r.customerBlock.idNumber ?? blank}
      </Text>
      <Text style={styles.text}>Signature: {blank}</Text>
      <Rule />
      <Text style={styles.small}>POS Provider: {r.provider.name ?? '—'}</Text>
      <Text style={styles.small}>Address: {r.provider.address ?? '—'}</Text>
      <Text style={styles.small}>TIN: {r.provider.tin ?? '—'}</Text>
      <Text style={styles.small}>BIR Accreditation No.: {r.provider.accreditationNo ?? '—'}</Text>
      <Text style={styles.small}>
        Issued: {r.provider.accreditationIssued ?? '—'} Until: {r.provider.accreditationValidUntil ?? '—'}
      </Text>
      <Text style={styles.small}>PTU No.: {r.provider.ptuNo ?? '—'}</Text>
      <Text style={[styles.small, styles.center, { marginTop: 4 }]}>{r.provider.validityNote}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: '#ffffff', padding: 16, borderWidth: 1, borderColor: '#d0d0d0', alignSelf: 'center' },
  text: { fontFamily: MONO, fontSize: 13, color: '#000000' },
  small: { fontFamily: MONO, fontSize: 11, color: '#000000' },
  title: { fontFamily: MONO, fontSize: 16, color: '#000000' },
  bold: { fontWeight: '700' },
  center: { textAlign: 'center' },
  flex: { flex: 1, paddingRight: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  qty: { width: 36, textAlign: 'right' },
  price: { width: 72, textAlign: 'right' },
  amount: { width: 92, textAlign: 'right' },
  rule: { borderBottomWidth: 1, borderBottomColor: '#000000', borderStyle: 'dashed', marginVertical: 6 },
  mark: { fontFamily: MONO, fontSize: 16, fontWeight: '800', textAlign: 'center', color: '#000000', marginBottom: 4 },
});
