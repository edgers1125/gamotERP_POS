// Left side of the Sell screen: search the cached catalog (offline) and tap to add. The search box doubles as the
// input of a USB/Bluetooth barcode scanner (it "types" the code and Enter): Enter looks the text up as a barcode / SKU
// code first, then adds the only match. The camera button opens the camera scanner.
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PosCatalog, PosCatalogItem } from '@pos-api/contract';
import { Button } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';
import { findByBarcode, searchCatalog } from '../../sale/catalogSearch';
import { priceAt } from '../../sale/cart';
import { formatPeso } from '../../sale/money';
import { BarcodeScannerModal, type ScanOutcome } from './BarcodeScannerModal';

export function ProductSearch({
  catalog,
  channelId,
  channelName,
  onAdd,
  disabled,
}: {
  catalog: PosCatalog | null;
  channelId: number | null;
  channelName: string;
  /** Adds one unit; returns an error message when it can't. */
  onAdd: (item: PosCatalogItem) => string | null;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosCatalogItem[]>([]);
  const [message, setMessage] = useState<ScanOutcome | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchCatalog(query, catalog)
        .then((rows) => {
          if (mine === seq.current) setResults(rows);
        })
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [query, catalog]);

  function add(item: PosCatalogItem): ScanOutcome {
    const err = onAdd(item);
    const outcome = err ? { ok: false, message: err } : { ok: true, message: `Added ${item.final_name}` };
    setMessage(outcome);
    return outcome;
  }

  async function lookup(code: string): Promise<ScanOutcome> {
    const hit = await findByBarcode(code, catalog);
    if (!hit) return { ok: false, message: `No item has the barcode ${code}.` };
    return add(hit);
  }

  async function submit() {
    const text = query.trim();
    if (text === '' || disabled) return;
    const hit = await findByBarcode(text, catalog);
    if (hit) {
      add(hit);
      setQuery('');
    } else if (results.length === 1) {
      add(results[0]!);
      setQuery('');
    } else {
      setMessage({ ok: false, message: results.length === 0 ? `Nothing matches “${text}”.` : 'Several items match — tap one.' });
    }
    inputRef.current?.focus();
  }

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setMessage(null);
          }}
          onSubmitEditing={() => void submit()}
          submitBehavior="submit"
          placeholder="Search name, SKU code or scan a barcode"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={styles.input}
          editable={!disabled}
        />
        {query !== '' ? <Button title="Clear" variant="ghost" compact onPress={() => setQuery('')} /> : null}
        <Button title="Scan" variant="secondary" onPress={() => setScannerOpen(true)} disabled={disabled} />
      </View>
      {message ? <Text style={[styles.message, { color: message.ok ? colors.success : colors.danger }]}>{message.message}</Text> : null}

      <FlatList
        data={results}
        key="grid-3"
        numColumns={3}
        keyExtractor={(i) => String(i.sku_id)}
        keyboardShouldPersistTaps="handled"
        columnWrapperStyle={{ gap: spacing.sm }}
        contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xl }}
        ListEmptyComponent={
          <Text style={styles.empty}>{catalog ? (query ? 'No item matches.' : 'The price list is empty.') : 'Loading the price list…'}</Text>
        }
        renderItem={({ item }) => {
          const price = priceAt(item, channelId);
          const unavailable = price === null;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.final_name}${unavailable ? ', no price at this channel' : `, ${formatPeso(price)}`}`}
              disabled={disabled || unavailable}
              onPress={() => add(item)}
              style={({ pressed }) => [styles.tile, unavailable && styles.tileOff, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.tileName} numberOfLines={3}>
                {item.final_name}
              </Text>
              <Text style={styles.tileCode} numberOfLines={1}>
                {item.sku_code}
                {item.sc_pwd_eligible ? '  ·  SC/PWD' : ''}
              </Text>
              <Text style={[styles.tilePrice, unavailable && { color: colors.muted, fontSize: font.small }]}>
                {unavailable ? `No price at ${channelName}` : formatPeso(price)}
              </Text>
            </Pressable>
          );
        }}
        style={{ flex: 1 }}
      />

      <BarcodeScannerModal visible={scannerOpen} onClose={() => setScannerOpen(false)} onScanned={lookup} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  input: {
    flex: 1,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: font.body + 1,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  message: { fontSize: font.small + 1, fontWeight: '600', marginBottom: spacing.sm },
  empty: { color: colors.muted, fontSize: font.body, padding: spacing.lg, textAlign: 'center' },
  tile: {
    flex: 1 / 3,
    minHeight: 112,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  tileOff: { backgroundColor: colors.background },
  tileName: { fontSize: font.body, fontWeight: '600', color: colors.text },
  tileCode: { fontSize: font.small, color: colors.muted, marginTop: spacing.xs },
  tilePrice: { fontSize: font.body + 2, fontWeight: '700', color: colors.primary, marginTop: spacing.xs },
});
