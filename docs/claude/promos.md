# Store promos — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/sale/promos.ts` — `promosOf`, `chargedLine`
- `src/sale/cart.ts` — `setPromos`, `refreshPromos`, `promoChoice`; `src/sale/checkout.ts` — `completeSale`, `PromoChangedError`
- `src/sale/usePosData.ts` — reloads on a new bootstrap
- `src/screens/SellScreen.tsx` — `cart.setPromos`; `src/screens/PaymentScreen.tsx` — `record` → `cart.refreshPromos`
- `src/components/sale/CartLineRow.tsx`, `src/components/sale/ReceiptView.tsx`, `src/components/sale/TotalsSummary.tsx`
- `src/sale/receipt.ts` — receipt snapshot (`ReceiptLineSnapshot.promoName`)
- `scripts/promo-selftest.ts` — self-test

### Store promos (`src/sale/promos.ts`, contract `PosPromo`, `GamotERP/apps/pharma/docs/plans/labels-promos-recommendations.md` decisions 4–6 + "POS app work")

- **Source:** bootstrap `promos` (published, this branch, not ended — scheduled ones included so they start/stop on time
  OFFLINE), cached with the bootstrap JSON; read by `promosOf` (absent from an older server → none; malformed entries
  skipped). Publish / cancel / end early change `bootstrap_version` → real-time `changed` 'terminal' → bootstrap re-read
  (existing path) → `usePosData` reloads → SellScreen `cart.setPromos` re-checks the cart. A promo ending on time needs
  no notice (judged by time).
- **The price** is only `@shared/promos/promo-math` (never re-implemented): a line of a listed SKU is charged
  `promoUnitPrice(channel price, promo)` when that is LOWER (else the promo doesn't apply). A cart line keeps its REGULAR
  price (`unitPrice` / `unitPriceText`) + `promo` (+ `promoChoice`); what's charged = `chargedLineOf` / `chargedLine`.
- **When it's judged:** at add-to-cart, on a channel / catalog re-price, every 15 s while the Sell screen has lines,
  on a new bootstrap, and at **Complete sale** (`PaymentScreen.record` → `cart.refreshPromos(soldAt)`; a change stops
  the sale with a message — the amount due moved — and `completeSale` refuses (`PromoChangedError`) if the lines don't
  match the promos at `soldAt`). **Clock:** the DEVICE clock, and that same instant is the sale's `sold_at` — the server
  judges the promo at `sold_at`, so both agree; since 2026-10-12 it is device clock + server offset (`stampClock()`, same value as the
  sale's `sold_at`); a wrong clock is the server's CLOCK_DRIFT flag, a promo outside its window PRICE_MISMATCH (recorded as charged).
- **Senior/PWD + promo item (decision 6):** each eligible promo line shows both amounts (`compareScPwd`: "Promo …" vs
  "Senior/PWD 20%"), the cheaper one for the customer marked "Better for the customer", and "By law the customer gets
  the better of the two — the promo or the Senior/PWD 20% — never both". **No default**; Charge stays off until each is
  chosen (`promoChoiceProblem` in `cartProblem`). PROMO → promo price, `statutoryDiscountRate: 0` (VAT-exempt, no 20 %);
  SCPWD → regular price + 20 %. A different promo / price on the line clears the choice.
- **Payload** (`SaleLinePayload`, signed as usual): `unit_price` = as charged; a promo line adds `promo_id`,
  `regular_unit_price`, `promo_vs_scpwd` (the choice on a Senior/PWD line — SCPWD still sends the promo it passed over —
  else null). Lines without a promo send none of them (older servers unaffected).
- **Screens:** cart line = regular price struck through + promo price + "Promo: <name> · 15% off" chip; Payment lists
  the promo / the choice per line; customer display shows `qty × regular = regular amount` then "Promo: <name> −x".
  **Receipt** (shared `receipt-layout` item `promo`, like the web's `SalesReceipt`): the item at the regular price, then
  "Promo: <name>  −x"; the name comes from the receipt snapshot (`ReceiptLineSnapshot.promoName`), else the cached
  bootstrap, else "Store promo"; reprint totals use `promo_vs_scpwd` (`computePayloadTotals`).
- Self-test: `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/promo-selftest.ts`
  (in force / not yet / ended / end exclusive, overlap → lower, rounding, re-checks, choice, payload, pricing with rate 0).
- **Release:** additive both ways — this build works against an older server (no promos), and an older build against
  the new server sells at the regular price (the server flags those sales "was in force but not applied"). Raise the
  terminals' `min_app_version` to this build once the fleet runs it, so no tablet keeps selling at full price during promos.
