// Left side of the Sell screen: search the cached catalog (offline) and tap to add. Results are shown as one tile per
// product model; a model with several sellable SKUs (pack sizes / variants) opens ModelPickerSheet to pick one, a model
// with one adds it at once. The search box doubles as the
// input of a USB/Bluetooth barcode scanner (it "types" the code and Enter): Enter looks the text up as a barcode / SKU
// code first, then adds the only match. The Scan button opens a small camera panel right under the search box (the
// grid moves down; the cart on the right is never covered).
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import type { PosCatalog, PosCatalogItem } from '@pos-api/contract';
import { Button } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, shadow, spacing } from '../../ui/theme';
import { findByBarcode, groupByModel, searchCatalog, type CatalogGroup } from '../../sale/catalogSearch';
import { priceAt } from '../../sale/cart';
import { formatPeso } from '../../sale/money';
import { BarcodeScannerPanel, type ScanOutcome } from './BarcodeScannerPanel';
import { ModelPickerSheet } from './ModelPickerSheet';
import { StatusBadge } from './ui';

// How many SKUs a typed search brings back (grouped into fewer tiles). An empty query shows the whole catalog.
const SEARCH_LIMIT = 200;

/** The priced SKUs of a group at the channel, with the price range. */
function sellableOf(group: CatalogGroup, channelId: number | null) {
  const priced: { item: PosCatalogItem; price: number }[] = [];
  for (const item of group.items) {
    const p = priceAt(item, channelId);
    if (p !== null) priced.push({ item, price: Number(p) });
  }
  const prices = priced.map((x) => x.price);
  return {
    items: priced.map((x) => x.item),
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
  };
}

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
  const styles = useStyles();
  const theme = useThemeColors();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosCatalogItem[]>([]);
  const [message, setMessage] = useState<ScanOutcome | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState<CatalogGroup | null>(null);
  const inputRef = useRef<TextInput>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (query.trim() === '') {
      // Nothing typed: the whole cached catalog, grouped.
      setResults(catalog?.items ?? []);
      return;
    }
    const t = setTimeout(() => {
      searchCatalog(query, catalog, SEARCH_LIMIT)
        .then((rows) => {
          if (mine === seq.current) setResults(rows);
        })
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [query, catalog]);

  const groups = useMemo(() => groupByModel(results), [results]);

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
    } else if (groups.length === 1) {
      // Several SKUs, all of one model: add the only priced one, or let the cashier pick.
      const sellable = sellableOf(groups[0]!, channelId).items;
      if (sellable.length === 1) {
        add(sellable[0]!);
        setQuery('');
      } else if (sellable.length === 0) {
        setMessage({ ok: false, message: `${groups[0]!.name} has no price at ${channelName}.` });
      } else {
        setPicking(groups[0]!);
      }
    } else {
      setMessage({ ok: false, message: results.length === 0 ? `Nothing matches “${text}”.` : 'Several items match — tap one.' });
    }
    inputRef.current?.focus();
  }

  function pressGroup(group: CatalogGroup) {
    const sellable = sellableOf(group, channelId).items;
    if (sellable.length === 1) add(sellable[0]!);
    else if (sellable.length > 1) setPicking(group);
  }

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <TextInput
          ref={inputRef}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          selectionColor={theme.primary}
          cursorColor={theme.primary}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setMessage(null);
          }}
          onSubmitEditing={() => void submit()}
          submitBehavior="submit"
          placeholder="Search name, SKU code or scan a barcode"
          placeholderTextColor={theme.muted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.input, focused && styles.inputFocused, disabled && styles.inputDisabled]}
          editable={!disabled}
        />
        {query !== '' ? <Button title="Clear" variant="ghost" compact onPress={() => setQuery('')} /> : null}
        <Button
          title={scannerOpen ? 'Hide camera' : 'Scan'}
          variant="secondary"
          onPress={() => setScannerOpen((open) => !open)}
          disabled={disabled && !scannerOpen}
        />
      </View>
      {scannerOpen && !disabled ? <BarcodeScannerPanel onClose={() => setScannerOpen(false)} onScanned={lookup} /> : null}
      {message && !scannerOpen ? <Text style={[styles.message, { color: message.ok ? theme.success : theme.danger }]}>{message.message}</Text> : null}

      <FlatList
        data={groups}
        key="grid-3"
        numColumns={3}
        keyExtractor={(g) => g.key}
        keyboardShouldPersistTaps="handled"
        columnWrapperStyle={{ gap: spacing.sm }}
        contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xl }}
        ListEmptyComponent={
          <Text style={styles.empty}>{catalog ? (query ? 'No item matches.' : 'The price list is empty.') : 'Loading the price list…'}</Text>
        }
        renderItem={({ item: group }) => {
          const { items: sellable, min, max } = sellableOf(group, channelId);
          const unavailable = sellable.length === 0;
          const options = group.items.length;
          const scPwd = group.items.some((i) => i.sc_pwd_eligible);
          const priceText = min === null ? null : min === max ? formatPeso(min) : `${formatPeso(min)} – ${formatPeso(max!)}`;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${group.name}${options > 1 ? `, ${options} options` : ''}${unavailable ? ', no price at this channel' : `, ${priceText}`}`}
              disabled={disabled || unavailable}
              onPress={() => pressGroup(group)}
              style={({ pressed }) => [styles.tile, unavailable && styles.tileOff, pressed && styles.tilePressed]}
            >
              <Text style={styles.tileName} numberOfLines={3}>
                {group.name}
              </Text>
              <View style={styles.tileMeta}>
                {options > 1 ? (
                  <Text style={[styles.tileOptions, unavailable && styles.tileOptionsOff]} numberOfLines={1}>
                    {options} options ›
                  </Text>
                ) : (
                  <Text style={styles.tileCode} numberOfLines={1}>
                    {group.items[0]!.sku_code}
                  </Text>
                )}
                {scPwd ? <StatusBadge label="SC/PWD" tone="primary" /> : null}
              </View>
              <Text style={[styles.tilePrice, unavailable && styles.tilePriceOff]} numberOfLines={1} adjustsFontSizeToFit>
                {unavailable ? `No price at ${channelName}` : priceText}
              </Text>
            </Pressable>
          );
        }}
        style={{ flex: 1 }}
      />

      <ModelPickerSheet
        group={picking}
        channelId={channelId}
        channelName={channelName}
        disabled={disabled}
        onPick={(item) => {
          add(item);
          setPicking(null);
        }}
        onClose={() => setPicking(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  input: {
    ...t.body,
    flex: 1,
    minHeight: 52,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: c.surface,
  },
  // 2px primary while focused (MUI outlined); padding drops by 1 so the text doesn't move.
  inputFocused: { borderWidth: 2, borderColor: c.primary, paddingHorizontal: spacing.md - 1 },
  inputDisabled: { backgroundColor: c.surfaceMuted, borderColor: c.border, color: c.muted },
  message: { ...t.caption, fontFamily: t.bodyStrong.fontFamily, fontSize: 14, marginBottom: spacing.sm },
  empty: { ...t.body, color: c.muted, padding: spacing.lg, textAlign: 'center' },
  tile: {
    flex: 1 / 3,
    minHeight: 112,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    justifyContent: 'space-between',
    ...shadow.card,
  },
  tilePressed: { backgroundColor: c.primarySoft, borderColor: c.primary },
  tileOff: { backgroundColor: c.surfaceMuted, elevation: 0, shadowOpacity: 0 },
  tileName: { ...t.subtitle, fontFamily: t.bodyStrong.fontFamily, fontSize: 15 },
  tileMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  tileCode: { ...t.caption, flexShrink: 1 },
  tileOptions: { ...t.label, color: c.primary, flexShrink: 1 },
  tileOptionsOff: { color: c.muted },
  tilePrice: { ...t.money, fontSize: 18, color: c.primary, marginTop: spacing.xs },
  tilePriceOff: { ...t.caption, marginTop: spacing.xs },
}));
