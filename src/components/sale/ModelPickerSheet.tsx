// Picks which SKU (pack size / variant) of a product model to add, when a Sell-screen model tile offers several.
// One large touch row per SKU; tapping a priced one adds one unit and closes the sheet.
import { Pressable, Text, View } from 'react-native';
import type { PosCatalogItem } from '@pos-api/contract';
import { makeStyles } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { priceAt } from '../../sale/cart';
import { formatPeso } from '../../sale/money';
import { variantLabelOf, type CatalogGroup } from '../../sale/catalogSearch';
import { Sheet } from './ui';

export function ModelPickerSheet({
  group,
  channelId,
  channelName,
  disabled,
  onPick,
  onClose,
}: {
  group: CatalogGroup | null;
  channelId: number | null;
  channelName: string;
  disabled?: boolean;
  onPick: (item: PosCatalogItem) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const items = group ? [...group.items].sort((a, b) => a.pack_quantity - b.pack_quantity || a.sku_id - b.sku_id) : [];
  return (
    <Sheet visible={group !== null} title={group?.name ?? ''} onClose={onClose}>
      <Text style={styles.hint}>Choose which one to add.</Text>
      <View style={styles.list}>
        {items.map((item) => {
          const price = priceAt(item, channelId);
          const off = price === null;
          const label = variantLabelOf(item);
          return (
            <Pressable
              key={item.sku_id}
              accessibilityRole="button"
              accessibilityLabel={`${label}${off ? `, no price at ${channelName}` : `, ${formatPeso(price)}`}`}
              accessibilityState={{ disabled: !!disabled || off }}
              disabled={disabled || off}
              onPress={() => onPick(item)}
              style={({ pressed }) => [styles.row, off && styles.rowOff, pressed && styles.rowPressed]}
            >
              <View style={styles.rowMain}>
                <Text style={[styles.label, off && styles.textOff]} numberOfLines={2}>
                  {label}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.sku_code} · {item.pack_quantity} {item.pack_quantity === 1 ? 'pc' : 'pcs'} per pack
                </Text>
              </View>
              <Text style={off ? styles.priceOff : styles.price}>{off ? `No price at ${channelName}` : formatPeso(price)}</Text>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  hint: { ...t.caption, marginBottom: spacing.sm },
  list: { gap: spacing.sm },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: c.primaryTintBorder,
    borderRadius: radius.md,
    backgroundColor: c.surface,
  },
  rowPressed: { backgroundColor: c.primaryTint, borderColor: c.primary },
  rowOff: { backgroundColor: c.surfaceMuted, borderColor: c.border },
  rowMain: { flex: 1 },
  label: { ...t.bodyStrong },
  textOff: { color: c.disabled },
  meta: { ...t.caption, marginTop: 2 },
  price: { ...t.money, fontSize: 18, color: c.primary },
  priceOff: { ...t.caption },
}));
