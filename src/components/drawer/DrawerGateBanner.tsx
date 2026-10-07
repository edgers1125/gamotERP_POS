// The Sell / Payment screens' "cash drawer closed" banner, with a button to the Cash drawer section.
import { useNavigation } from '@react-navigation/native';
import type { StyleProp, ViewStyle } from 'react-native';

import { DRAWER_CLOSED_MESSAGE } from '../../drawer/cashDrawer';
import type { DrawerGate } from '../../drawer/useCashDrawer';
import { Banner } from '../../ui/components';

export function DrawerGateBanner({ gate, style }: { gate: DrawerGate; style?: StyleProp<ViewStyle> }) {
  const navigation = useNavigation();
  if (gate.checking || !gate.problem) return null;
  const closed = gate.problem === DRAWER_CLOSED_MESSAGE;
  return (
    <Banner
      kind="warning"
      title={closed ? 'Cash drawer closed' : 'Cash drawer'}
      message={gate.problem}
      actionLabel={closed ? 'Open drawer' : 'Cash drawer'}
      onAction={() => navigation.navigate('CashDrawer')}
      style={style}
    />
  );
}
