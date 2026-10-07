// "Sold By": who the sale is credited to — one of the branch's Sales Staff (bootstrap.sales_staff), picked by the
// cashier (no PIN). Never filled in by the app; "Me" when the cashier is on the list. The choice stays for the next sale
// until changed or the till locks (src/auth/tillLock.ts). The server re-checks the person is still on the list when the
// sale syncs (recorded + flagged if not). User decision 2026-10-07 — GamotERP docs/plans/sales-incentives.md
// "As built — cashier vs seller, idle lock".
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../ui/theme';
import { Button } from '../../ui/components';
import { HintText, OptionTile, Sheet } from './ui';

export function SoldByDialog({
  visible,
  staff,
  value,
  cashier,
  onPick,
  onClose,
}: {
  visible: boolean;
  staff: { id: number; name: string }[];
  value: number | null;
  /** The signed-in cashier — the "Me" shortcut when they are on the Sales Staff list. */
  cashier: { userId: number; name: string } | null;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const me = cashier && staff.some((s) => s.id === cashier.userId) ? cashier : null;
  const pick = (id: number) => {
    onPick(id);
    onClose();
  };
  return (
    <Sheet visible={visible} title="Who sold it?" onClose={onClose} width={640}>
      {staff.length === 0 ? (
        <HintText>
          No one is on this branch’s Sales Staff yet — a manager adds them in Branches › Manage Access › Sales Staff. A sale can’t be completed until
          then.
        </HintText>
      ) : (
        <>
          <HintText>
            {cashier ? `Cashier: ${cashier.name}. ` : ''}Pick who made the sale — it stays chosen for the next sales until you change it or the till
            locks.
          </HintText>
          {me ? (
            <Button
              title={value === me.userId ? `Me (${me.name}) ✓` : `Me (${me.name})`}
              variant={value === me.userId ? 'primary' : 'secondary'}
              onPress={() => pick(me.userId)}
              style={styles.me}
            />
          ) : null}
          <View style={styles.grid}>
            {staff.map((s) => (
              <OptionTile key={s.id} label={s.name} selected={s.id === value} onPress={() => pick(s.id)} style={styles.item} />
            ))}
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  item: { minHeight: 56 },
  me: { alignSelf: 'flex-start', marginVertical: spacing.sm },
});
