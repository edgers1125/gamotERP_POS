// Mount ONCE (App.tsx's Shell): the customer display follows the cart for as long as the app runs — also while the
// till is locked or before a cashier signs in (it then shows the idle ads/brand). See src/display/customerDisplay.ts.
import { useEffect } from 'react';

import { customerDisplay } from './customerDisplay';

export function useCustomerDisplay(): void {
  useEffect(() => customerDisplay.start(), []);
}
