// "Bill to company" (BIR Phase 1; docs/plans/bir-phase1-invoice-contract.md §1, §5) on the Payment screen: an optional
// client company buyer. Online search (GET /pos/client-companies, like ClientSearch for clients); offline it is disabled
// — the company, its TIN and its withholding rates only exist on the server. A company with no TIN on record asks for one
// (required from ₱1,000); the withholding comes from the company's effective rates through the shared maths
// (src/sale/billing.ts) and "Change withholding" asks for new rates + a reason (audited on the server). Nothing here when
// no company is picked: the sale is exactly as before.
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PosClientCompany } from '@pos-api/contract';
import { api } from '../../api/client';
import { Button, TextField } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { buyerTinOf, companyRates, ratesOf, type BillToDraft, type BillingFigures } from '../../sale/billing';
import { cleanDecimalInput, formatPeso } from '../../sale/money';
import { HintText, Sheet, SummaryRow } from './ui';
import { canSearchClients } from './ClientSearch';

export const BILL_TO_OFFLINE_MESSAGE = 'Needs a connection — sell as walk-in or wait.';

function CompanySearch({ onPick }: { onPick: (c: PosClientCompany) => void }) {
  const styles = useStyles();
  const theme = useThemeColors();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PosClientCompany[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRows([]);
      setState('idle');
      return;
    }
    const mine = ++seq.current;
    setState('loading');
    const t = setTimeout(() => {
      api
        .clientCompanies(q)
        .then((list) => {
          if (mine !== seq.current) return;
          setRows(list);
          setState('idle');
        })
        .catch(() => {
          if (mine === seq.current) setState('error');
        });
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <View>
      <TextField value={query} onChangeText={setQuery} placeholder="Company name, code or TIN" autoCorrect={false} containerStyle={{ marginBottom: spacing.sm }} />
      {state === 'loading' ? <HintText>Searching…</HintText> : null}
      {state === 'error' ? <Text style={styles.error}>Couldn’t search companies — check the connection.</Text> : null}
      {state === 'idle' && query.trim().length >= 2 && rows.length === 0 ? <HintText>No client company matches.</HintText> : null}
      {rows.slice(0, 20).map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          onPress={() => onPick(c)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.primarySoft }]}
        >
          <Text style={styles.name}>{c.name}</Text>
          <Text style={styles.meta}>{[c.tin ? `TIN ${c.tin}` : 'No TIN on record', c.withholding_label].join('  ·  ')}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function BillToCompany({
  bill,
  figures,
  online,
  onChange,
  disabled,
}: {
  bill: BillToDraft | null;
  figures: BillingFigures | null;
  online: boolean;
  onChange: (bill: BillToDraft | null) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(false);
  const canSearch = canSearchClients(online);

  if (!bill) {
    return (
      <View style={styles.card}>
        <View style={styles.headRow}>
          <Text style={styles.title}>Bill to company</Text>
          <Button title="Choose company" variant="secondary" compact onPress={() => setSearching(true)} disabled={disabled || !canSearch} />
        </View>
        {!canSearch ? (
          <HintText>{BILL_TO_OFFLINE_MESSAGE}</HintText>
        ) : (
          <HintText>Optional — for a company that withholds tax. Leave empty for a walk-in or individual sale.</HintText>
        )}
        <Sheet visible={searching} title="Bill to company" onClose={() => setSearching(false)} width={640}>
          <CompanySearch
            onPick={(company) => {
              onChange({ company, tin: '', override: null });
              setSearching(false);
            }}
          />
        </Sheet>
      </View>
    );
  }

  const c = bill.company;
  const rates = ratesOf(bill);
  const overridden = bill.override !== null;
  const tin = buyerTinOf(bill);
  const setOverride = (patch: Partial<NonNullable<BillToDraft['override']>>) => {
    const cr = companyRates(c);
    const cur = bill.override ?? { ewtRate: cr.ewtRate.toFixed(2), vatRate: cr.vatRate.toFixed(2), reason: '' };
    onChange({ ...bill, override: { ...cur, ...patch } });
  };

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.flex}>
          <Text style={styles.title}>Bill to: {c.name}</Text>
          {c.address ? <Text style={styles.meta}>{c.address}</Text> : null}
        </View>
        <Button title="Remove" variant="ghost" compact onPress={() => onChange(null)} disabled={disabled} />
      </View>

      {c.tin && c.tin.trim() !== '' ? (
        <Text style={styles.meta}>TIN: {c.tin}</Text>
      ) : (
        <TextField
          label="Company TIN (required from ₱1,000)"
          value={bill.tin}
          onChangeText={(t) => onChange({ ...bill, tin: t })}
          placeholder="000-000-000-000"
          autoCorrect={false}
          editable={!disabled}
          containerStyle={{ marginTop: spacing.sm }}
          hint={tin ? null : 'Saved to the company when it has none.'}
        />
      )}

      <Text style={[styles.meta, { marginTop: spacing.sm }]}>
        Withholding: {overridden ? `EWT ${rates.ewtRate}% + VAT ${rates.vatRate}% (changed)` : c.withholding_label}
      </Text>
      {figures ? (
        <View style={{ marginTop: spacing.xs }}>
          <SummaryRow label="Less: Withholding Tax" value={formatPeso(-figures.amounts.amount)} tone="muted" />
        </View>
      ) : null}

      {editing ? (
        <View style={{ marginTop: spacing.sm }}>
          <View style={styles.rateRow}>
            <TextField
              label="EWT %"
              value={bill.override?.ewtRate ?? companyRates(c).ewtRate.toFixed(2)}
              onChangeText={(t) => setOverride({ ewtRate: cleanDecimalInput(t) })}
              keyboardType="decimal-pad"
              containerStyle={styles.flex}
            />
            <TextField
              label="VAT withheld %"
              value={bill.override?.vatRate ?? companyRates(c).vatRate.toFixed(2)}
              onChangeText={(t) => setOverride({ vatRate: cleanDecimalInput(t) })}
              keyboardType="decimal-pad"
              containerStyle={styles.flex}
            />
          </View>
          <TextField
            label="Reason for changing the withholding"
            value={bill.override?.reason ?? ''}
            onChangeText={(t) => setOverride({ reason: t })}
            maxLength={500}
          />
          <View style={styles.headRow}>
            <Button
              title="Use the company’s rates"
              variant="ghost"
              compact
              onPress={() => {
                onChange({ ...bill, override: null });
                setEditing(false);
              }}
            />
            <Button title="Done" variant="secondary" compact onPress={() => setEditing(false)} />
          </View>
        </View>
      ) : (
        <Button title="Change withholding" variant="ghost" compact onPress={() => setEditing(true)} disabled={disabled} style={{ alignSelf: 'flex-start', marginTop: spacing.xs }} />
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  rateRow: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
  title: { ...t.bodyStrong },
  row: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  name: { ...t.bodyStrong },
  meta: { ...t.caption },
  error: { ...t.caption, color: c.danger },
}));
