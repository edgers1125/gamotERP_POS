// "Sold By": who the sale is credited to — one of the branch's Sales Staff (bootstrap.sales_staff). The server
// re-checks the person is still on the list when the sale syncs.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../ui/theme';
import { HintText, Sheet } from './ui';

export function SoldByDialog({
  visible,
  staff,
  value,
  onPick,
  onClose,
}: {
  visible: boolean;
  staff: { id: number; name: string }[];
  value: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Sold By" onClose={onClose} width={640}>
      {staff.length === 0 ? (
        <HintText>No one is on this branch’s Sales Staff yet — a manager adds them in Branch Tracker › Manage Access › Sales Staff.</HintText>
      ) : (
        <View style={styles.grid}>
          {staff.map((s) => {
            const on = s.id === value;
            return (
              <Pressable
                key={s.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  onPick(s.id);
                  onClose();
                }}
                style={[styles.item, on && styles.itemOn]}
              >
                <Text style={[styles.text, on && { color: '#fff' }]} numberOfLines={1}>
                  {s.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  item: {
    width: '48%',
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  itemOn: { backgroundColor: colors.primary },
  text: { fontSize: font.body, fontWeight: '600', color: colors.primary },
});
