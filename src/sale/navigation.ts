// Route params of the selling screens. The navigation shell (App.tsx, P-A4) includes these three routes, with these
// exact names and params, in its native-stack param list:
//   Sell    → SellScreen     (no params)       the till: catalog/search left, cart right
//   Payment → PaymentScreen  (no params)       tender for the cart in `useCart`; records the sale
//   Receipt → ReceiptScreen  { clientUuid }    the recorded sale's receipt (also usable for a reprint from Sales Today)
// Payment → Receipt uses `replace`, and Receipt's "New sale" uses `popTo('Sell')`.
export type SaleStackParamList = {
  Sell: undefined;
  Payment: undefined;
  Receipt: { clientUuid: string; reprint?: boolean };
};
