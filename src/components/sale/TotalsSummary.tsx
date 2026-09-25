// The sale's figures, straight from the shared pricing code's result (src/sale/totals.ts). Prices are before VAT, so
// VAT is added on top; Senior/PWD lines are VAT-exempt.
import { View } from 'react-native';
import type { SaleTotals } from '../../sale/totals';
import { formatPeso } from '../../sale/money';
import { SummaryRow } from './ui';

export function TotalsSummary({ totals, statutoryLabel }: { totals: SaleTotals; statutoryLabel?: string }) {
  return (
    <View>
      <SummaryRow label="Subtotal" value={formatPeso(totals.subtotal)} />
      {totals.totalItemDiscount > 0 ? <SummaryRow label="Item discounts" value={formatPeso(-totals.totalItemDiscount)} tone="success" /> : null}
      {totals.transactionDiscountAmount > 0 ? <SummaryRow label="Sale discount" value={formatPeso(-totals.transactionDiscountAmount)} tone="success" /> : null}
      {totals.totalStatutoryDiscount > 0 ? (
        <SummaryRow label={`${statutoryLabel ?? 'Senior/PWD'} 20%`} value={formatPeso(-totals.totalStatutoryDiscount)} tone="success" />
      ) : null}
      {totals.vatExemptSales > 0 ? <SummaryRow label="VAT-exempt sales" value={formatPeso(totals.vatExemptSales)} tone="muted" /> : null}
      <SummaryRow label="VAT (12%)" value={formatPeso(totals.totalVat)} tone="muted" />
      <SummaryRow label="Total" value={formatPeso(totals.grandTotal)} strong />
    </View>
  );
}
