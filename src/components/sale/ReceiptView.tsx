// The official receipt on screen — a React Native port of the web's receipt renderer
// (GamotERP/apps/pharma/frontend/src/components/receipt/SalesReceipt.tsx): same sections 1–10 in the same order, same labels,
// alignment, separators (dashed rules, a solid one above TOTAL), marks (VOID banner + watermark, RETURN banner,
// *** REPRINT *** top and bottom), logo, heading / message lines, paper width and font. The data is the shared
// builder's ReceiptData (src/sale/receipt.ts → @shared/receipt-layout), so every word and figure is the web's. Keep
// this file in step with SalesReceipt.tsx. Always black on white (only the logo may be in colour).
//
// Sizes: the web lays the receipt out in mm/pt at true paper size; here 1 mm = MM dp (80 mm paper = 400 dp wide) and
// every size is scaled by the same factor, so proportions match the web receipt exactly.
import { useEffect, useState, type ReactNode } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { formatReceiptMoney, receiptPaperWidthMm, type ReceiptData, type ReceiptFontKey } from '@shared/receipt-layout';
import { fontFamily } from '../../ui/theme';

const MM = 5; // dp per millimetre of paper
const pt = (n: number) => n * (25.4 / 72) * MM; // typographic points → dp at the same scale
const INK = '#000000';

interface Fonts {
  regular: TextStyle;
  bold: TextStyle;
}

// The web loads each font from Google Fonts; the tablet has no copies of the monospace ones, so every monospace key
// uses Android's monospace face, INTER the system sans-serif, and POPPINS the app's own bundled Poppins faces
// (a custom font's bold is its own face — fontWeight is ignored for those on Android).
function fontsFor(key: ReceiptFontKey): Fonts {
  if (key === 'POPPINS') return { regular: { fontFamily: fontFamily.regular }, bold: { fontFamily: fontFamily.bold } };
  const family = key === 'INTER' ? 'sans-serif' : 'monospace';
  return { regular: { fontFamily: family }, bold: { fontFamily: family, fontWeight: '700' } };
}

export function ReceiptView({ data }: { data: ReceiptData }) {
  const { settings, marks } = data;
  const narrow = receiptPaperWidthMm(settings.paper_width) === 58;
  const fs = pt(narrow ? 7.2 : 8.6); // the receipt's base font size (1em)
  const ch = fs * 0.6; // CSS `ch` of a monospace face
  const f = fontsFor(settings.font);

  const base: TextStyle = { ...f.regular, fontSize: fs, lineHeight: fs * 1.35, color: INK };
  const bold: TextStyle = { ...f.bold };
  const small: TextStyle = { fontSize: fs * 0.86, lineHeight: fs * 0.86 * 1.35 };
  const em = (k: number): TextStyle => ({ fontSize: fs * k, lineHeight: fs * k * 1.35 });

  const T = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) => <Text style={[base, style]}>{children}</Text>;
  const Center = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) => <T style={[styles.center, style]}>{children}</T>;
  const Divider = ({ strong }: { strong?: boolean }) => (
    <View style={{ borderTopWidth: 1, borderTopColor: INK, borderStyle: strong ? 'solid' : 'dashed', marginVertical: 2.2 * MM }} />
  );
  /** Label left, value right (the value never wraps under the label). */
  const Row = ({ label, value, isBold, text, style }: { label: string; value: string; isBold?: boolean; text?: TextStyle; style?: StyleProp<ViewStyle> }) => (
    <View style={[styles.row, { columnGap: 2 * MM }, style]}>
      <T style={[styles.shrink, isBold && bold, text]}>{label}</T>
      <T style={[styles.right, styles.tabular, isBold && bold, text]}>{value}</T>
    </View>
  );
  /** "Label: value" — or "Label: ________" to write on when the value is unknown. */
  const WriteOnLine = ({ label, value }: { label: string; value: string | null }) => (
    <View style={[styles.row, { alignItems: 'flex-end', columnGap: 1.5 * MM, marginTop: 1.6 * MM }]}>
      <T>{label}:</T>
      {value ? <T style={styles.shrink}>{value}</T> : <View style={{ flex: 1, borderBottomWidth: 1, borderBottomColor: INK, minHeight: fs }} />}
    </View>
  );
  const Banner = ({ children }: { children: string }) => (
    <View style={{ borderWidth: 1.5, borderColor: INK, paddingVertical: 1 * MM, marginBottom: 2.5 * MM }}>
      <T style={[styles.center, bold, em(1.15), { letterSpacing: 0.3 * fs * 1.15 }]}>{children}</T>
    </View>
  );
  const dash = (v: string | null) => (v && v.trim() ? v : '—');
  const m = formatReceiptMoney;

  // Item grid: 80 mm "1fr 6ch 10ch 11ch 2ch", 58 mm "1fr 7ch 9ch 10ch 2ch", 1 mm column gap.
  const [qW, pW, aW, fW] = (narrow ? [7, 9, 10, 2] : [6, 10, 11, 2]).map((n) => n * ch);
  const cell = (w: number): TextStyle => ({ width: w, marginLeft: 1 * MM, textAlign: 'right' });
  const padRight = (k: number): ViewStyle => ({ paddingRight: k * ch });

  return (
    <View
      style={[
        styles.paper,
        {
          width: receiptPaperWidthMm(settings.paper_width) * MM,
          paddingTop: (narrow ? 3 : 4) * MM,
          paddingHorizontal: (narrow ? 2.5 : 4) * MM,
          paddingBottom: (narrow ? 5 : 6) * MM,
        },
      ]}
    >
      {/* 10. Marks (top banners; VOID also gets a watermark over the whole receipt) */}
      {marks.voided ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.watermarkBox]}>
          <Text style={[f.bold, styles.watermark, { fontSize: pt(narrow ? 34 : 48), letterSpacing: 0.15 * pt(narrow ? 34 : 48) }]}>VOID</Text>
        </View>
      ) : null}
      {marks.voided ? <Banner>VOID</Banner> : null}
      {marks.is_return ? <Banner>RETURN</Banner> : null}
      {marks.reprint ? <Center style={[bold, { letterSpacing: 0.25 * fs, marginBottom: 2 * MM }]}>*** REPRINT ***</Center> : null}

      {/* 1. Logo */}
      {settings.show_logo && settings.logo_url ? (
        <ReceiptLogo uri={settings.logo_url} monochrome={settings.logo_mode === 'MONOCHROME'} maxWidth={0.62 * (receiptPaperWidthMm(settings.paper_width) - (narrow ? 5 : 8)) * MM} maxHeight={(narrow ? 18 : 24) * MM} />
      ) : null}

      {/* 2. Heading */}
      <Center style={[bold, em(1.12)]}>{data.heading.business_name}</Center>
      {data.heading.fixed_lines.map((line, i) => (
        <Center key={`f${i}`}>{line}</Center>
      ))}
      {data.heading.custom_lines.length > 0 ? (
        <View style={{ marginTop: 1.5 * MM }}>
          {data.heading.custom_lines.map((line, i) => (
            <Center key={`c${i}`}>{line || ' '}</Center>
          ))}
        </View>
      ) : null}

      <Divider />

      {/* 3. Sale type + POS + customer type */}
      <Row label={data.sale_type_label} value={data.customer_type_label ?? ''} isBold />
      {data.terminal_label || data.customer_name ? <Row label={data.terminal_label ?? ''} value={data.customer_name ?? ''} /> : null}

      <Divider />

      {/* 4. Transaction details */}
      <View style={styles.row}>
        <T style={[bold, styles.flex]}>Item</T>
        <T style={[bold, cell(qW)]}>Qty</T>
        <T style={[bold, cell(pW)]}>Price</T>
        <T style={[bold, cell(aW)]}>Amount</T>
        <View style={{ width: fW, marginLeft: 1 * MM }} />
      </View>
      {data.items.map((item, i) => (
        <View key={i}>
          <T style={{ marginTop: 1.2 * MM }}>{item.name}</T>
          <View style={styles.row}>
            <View style={styles.flex} />
            <T style={[styles.tabular, cell(qW)]}>{String(item.quantity)}</T>
            <T style={[styles.tabular, cell(pW)]}>{m(item.promo ? item.promo.regular_unit_price : item.unit_price)}</T>
            <T style={[styles.tabular, cell(aW)]}>{m(item.promo ? item.promo.regular_amount : item.amount)}</T>
            <T style={[bold, cell(fW)]}>{item.vat_flag}</T>
          </View>
          {/* Store promo (shared layout `promo`, like the web's SalesReceipt): "Promo: <name>" and its discount under the
              regular price — the Amount column still adds up. */}
          {item.promo ? (
            <View style={styles.row}>
              <T style={styles.flex}>{item.promo.label}</T>
              <T style={[styles.tabular, cell(aW)]}>{m(item.promo.discount)}</T>
              <View style={{ width: fW, marginLeft: 1 * MM }} />
            </View>
          ) : null}
        </View>
      ))}
      {data.adjustments.length > 0 ? (
        <View style={{ marginTop: 1.8 * MM }}>
          {data.adjustments.map((adj, i) => (
            <Row key={i} label={adj.label} value={m(adj.amount)} style={padRight(3)} />
          ))}
        </View>
      ) : null}
      <Divider strong />
      <Row label={`TOTAL: ${data.item_count} Item${data.item_count === 1 ? '' : 's'}`} value={m(data.total)} isBold text={em(1.2)} style={padRight(2.5)} />
      <View style={[{ marginTop: 1.2 * MM }, padRight(3)]}>
        {data.payments.map((p, i) => (
          <Row key={i} label={p.reference ? `${p.label} ${p.reference}` : p.label} value={m(p.amount)} />
        ))}
        {/* The Cash payment row is what cash paid toward the total; this is the cash actually handed over. */}
        {data.cash_received !== null ? <Row label="Cash received" value={m(data.cash_received)} /> : null}
      </View>
      {data.change !== null ? <Row label="CHANGE" value={m(data.change)} isBold text={em(1.12)} style={[{ marginTop: 0.8 * MM }, padRight(2.5)]} /> : null}

      <Divider />

      {/* 5. VAT declaration */}
      <View style={padRight(3)}>
        <Row label="VAT Sales" value={m(data.vat.vat_sales)} />
        <Row label="Non-VAT Sales (VAT-exempt)" value={m(data.vat.non_vat_sales)} />
        <Row label="Zero-Rated Sales" value={m(data.vat.zero_rated_sales)} />
        <Row label="Total Sales" value={m(data.vat.total_sales)} />
        <Row label="Total VAT" value={m(data.vat.total_vat)} />
        <Row label="Total Amount" value={m(data.vat.total_amount)} isBold />
        <Row label="Total Discount" value={m(data.vat.total_discount)} />
        <Row label="VAT Exemption" value={m(data.vat.vat_exemption)} />
      </View>
      <T style={[small, { marginTop: 1 * MM }]}>V = Vatable · E = VAT-exempt · Z = Zero-rated</T>

      <Divider />

      {/* 6. Trans No. + date/time */}
      <Row label="Trans No." value={data.invoice_number ?? '—'} isBold />
      <Row label="Date" value={data.issued_at_display} />
      {data.sale_reference ? <Row label="Ref" value={data.sale_reference} text={small} /> : null}
      {/* Who rang it up · who it is credited to (mirrors the web's SalesReceipt). */}
      {data.staff_line ? <T>{data.staff_line}</T> : null}

      <Divider />

      {/* 7. Title line + messages */}
      <Center style={[bold, em(1.05), { letterSpacing: 0.04 * fs * 1.05 }]}>{data.title_line}</Center>
      {data.message_lines.length > 0 ? (
        <View style={{ marginTop: 1.5 * MM }}>
          {data.message_lines.map((line, i) => (
            <Center key={i}>{line || ' '}</Center>
          ))}
        </View>
      ) : null}

      <Divider />

      {/* 8. Customer block */}
      <WriteOnLine label="Customer" value={data.customer_block.name} />
      <WriteOnLine label="Address" value={data.customer_block.address} />
      <WriteOnLine label="TIN" value={data.customer_block.tin} />
      <WriteOnLine label={data.customer_block.id_label} value={data.customer_block.id_number} />
      <WriteOnLine label="Signature" value={null} />

      <Divider />

      {/* 9. Other information (BIR) */}
      <View>
        <Center style={[small, bold, { marginBottom: 0.8 * MM }]}>POS System Provider</Center>
        <Center style={small}>{dash(data.provider.name)}</Center>
        <Center style={small}>{dash(data.provider.address)}</Center>
        <Center style={small}>TIN: {dash(data.provider.tin)}</Center>
        <Center style={small}>BIR Accreditation No.: {dash(data.provider.accreditation_no)}</Center>
        <Center style={small}>
          Issued: {dash(data.provider.accreditation_issued)} · Until: {dash(data.provider.accreditation_valid_until)}
        </Center>
        <Center style={small}>PTU No.: {dash(data.provider.ptu_no)}</Center>
        <Center style={[small, bold, { marginTop: 1.5 * MM }]}>{data.provider.validity_note}</Center>
      </View>

      {marks.reprint ? <Center style={[bold, { letterSpacing: 0.25 * fs, marginTop: 2.5 * MM }]}>*** REPRINT ***</Center> : null}
    </View>
  );
}

/** The logo at up to 62% of the paper's text width and 24 mm (18 mm on 58 mm paper) high, aspect ratio kept. */
function ReceiptLogo({ uri, monochrome, maxWidth, maxHeight }: { uri: string; monochrome: boolean; maxWidth: number; maxHeight: number }) {
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    Image.getSize(
      uri,
      (w, h) => live && w > 0 && h > 0 && setRatio(w / h),
      () => live && setRatio(null),
    );
    return () => {
      live = false;
    };
  }, [uri]);
  const width = ratio ? Math.min(maxWidth, maxHeight * ratio) : maxWidth;
  const height = ratio ? width / ratio : maxHeight;
  return (
    <View style={{ alignItems: 'center', marginBottom: 2.5 * MM }}>
      {/* MONOCHROME: rendered black & white like the web's grayscale(1) contrast(1.4) (the stored logo is the colour original). */}
      <View style={monochrome ? { filter: [{ grayscale: 1 }, { contrast: 1.4 }] } : undefined}>
        <Image source={{ uri }} style={{ width, height }} resizeMode="contain" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The paper on its tray (the border is screen chrome, like the web dialog's page outline).
  paper: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#d0d0d0', alignSelf: 'center', overflow: 'hidden' },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  tabular: { fontVariant: ['tabular-nums'] },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  watermarkBox: { alignItems: 'center', justifyContent: 'center' },
  watermark: { color: 'rgba(0,0,0,0.12)', transform: [{ rotate: '-35deg' }] },
});
