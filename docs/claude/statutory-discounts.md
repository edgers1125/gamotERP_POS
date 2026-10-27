# Statutory discounts (Senior / PWD / NAAC / Solo Parent / Medal of Valor) — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).
Contract: GamotERP `apps/pharma/docs/plans/bir-statutory-discounts-contract.md` (§2b several cards, §5 POS, §6 receipt);
plan: `docs/plans/bir-pos-accreditation.md` Phase 2 / 2b, decisions D7, D11. App **1.6.0** (versionCode 7 — 1.5.1 takes 6).

## File map

- `src/sale/statutory.ts` — the card draft (`StatutoryDraft`, + Solo Parent `bookletNumber` / `children` /
  `rxInChildName`), the company's rules from the bootstrap (`statutoryConfigOf` → `StatutoryConfig`), the card checks
  (`statutoryProblem`), a client's card on record (`clientStatutoryBlock`), the card payload (`statutoryPayload`).
- `src/sale/cards.ts` — PURE (no store / native code): line → card (`lineCardType`), what a line is charged
  (`chargedLineOf`, + its card's rate and VAT treatment), `cartTotals`, discount rows, `statutoryCardsProblem`,
  `promoCardComparison`, `statutoryFields` (the payload's `statutory_discount` / `statutory_cards`). `cart.ts` re-exports
  all of it; the zustand store keeps `statutory` (card 0), `extraCards`, `statutoryConfig`, `CartLine.soloParentEligible`
  / `cardPick`, actions `setStatutory`, `putExtraCard`, `removeExtraCard`, `setLineCard`, `setStatutoryConfig`.
- `src/sale/totals.ts` — `payloadCards`, `payloadLineCardTypes`, `payloadCardRule`, `computePayloadTotals` (receipt /
  reprint re-pricing from the signed payload).
- UI: `ClientDialog.tsx` (card 0 — type picker shows the OFFERED types), `ExtraCardDialog.tsx` ("Add another card"),
  `StatutoryCardParts.tsx` (Solo Parent block, expiry / issuer labels), `CartLineRow.tsx` (card label, promo-vs-card
  choice, per-line card chips), `SellScreen.tsx`, `PaymentScreen.tsx`, `TotalsSummary.tsx` (`statutoryRows`),
  `SettingsScreen.tsx` ("Statutory discounts" group, read-only), `ProductSearch.tsx` ("Solo Parent" badge),
  `src/display/customerDisplay.ts` (one row per type), `src/sale/receipt.ts` + `ReceiptView.tsx` (receipt).

## Rules (as built)

- **THE rules are the backend's** `@shared/statutory-rules` (import-free; in tsconfig `include`): eligibility flag per
  type (`statutoryLineEligible` — Solo Parent on `solo_parent_eligible`, the rest on `sc_pwd_eligible`), the line → card
  rule (`assignStatutoryLines`), ID expiry (`statutoryIdNeedsExpiry`: PWD + Solo Parent; `statutoryIdHasExpiry`: all but
  Senior), the Solo Parent child rule (`soloParentChildIssue`: ≤ 6 years old on the sale's Manila day), labels. Rate /
  VAT maths = `@shared/material-issuance-pricing` (`statutoryDiscountRate` fraction + `statutoryVatExempt`). Never
  re-implement either.
- **Company settings, edited on the web only** (Settings → Statutory discounts, permission
  `settings.statutorydiscounts`; user decision D11 "every default editable"). The tablet reads bootstrap
  `statutory_discounts` (`statutoryConfigOf`, defensive: SENIOR / PWD are always 20 %, exempt; a malformed entry keeps
  the type's default) and shows them read-only in Settings. Part of `bootstrap_version` → a save reaches the tablet as a
  real-time `changed` 'terminal'. The Sell screen pushes it into the cart (`setStatutoryConfig`, a system update — not a
  till touch); a change re-prices an open cart (the sale is charged at the rules in force when completed; the payload
  carries what was charged).
- **Older server** (no `statutory_discounts`): `LEGACY_STATUTORY_CONFIG` — Senior / PWD only, and the card payload
  is EXACTLY the pre-Phase-2 shape (no `rate` / `vat_exempt` / Solo Parent fields; an older server rejects unknown types).
- **One card (default):** `statutory_discount` = card 0 (+ `rate` "10.00", `vat_exempt`, and on SOLO_PARENT
  `booklet_number`, `children`, `rx_in_child_name` — null unless a Solo Parent line is an Rx item). Every line eligible
  for it gets it.
- **Several cards (Phase 2b)** — only while bootstrap `one_type_per_sale` is false: "+ Add another card" on the Sell
  screen (types offered, not on the sale, with an eligible item; never card 0's type); card 0's holder is the client,
  the others carry their own holder name. Each eligible line shows card chips (the cards it's eligible for + None);
  default = the first card it's eligible for. Payload: `statutory_cards` (card 0 first) + every line's `statutory_type`
  (null = none), `statutory_discount` null. Removing card 0 (client form "None") removes them all.
- **Checks before Charge** (`statutoryCardsProblem`, also run by `completeSale` on the sale's Manila day): type
  offered (Medal of Valor is OFF by default — D7), ID + names, expiry per type (an expired NAAC / MoV ID refused too),
  Solo Parent ≥ 1 child (≤ 10) each ≤ 6, attestation when a Solo Parent line is Rx, each card discounts ≥ 1 line,
  several cards only with the setting off, one card per type. A card discounts → no item discount on its lines and no
  transaction discount (cleared when the card is applied).
- **A client's card on record** is auto-applied when picked unless `clientStatutoryBlock` says why not (expired /
  undated ID, type off or unknown to the server, Solo Parent — needs this sale's child, so it is filled in the client
  form, never applied by itself).
- **Promo + card** (decision 6 of promos): the cashier chooses per line; Senior / PWD keep the shared `compareScPwd`;
  other types compare via the shared pricing on that line both ways (`promoCardComparison` — NAAC charges VAT). PROMO =
  promo price, rate 0, the type's VAT treatment. `promo_vs_scpwd` is sent for every type.
- **Withholding** (`src/sale/billing.ts`): a VAT-charged statutory line (NAAC) is VAT Sales for the government VAT
  withholding base — `statutoryVatExempt` is passed to `@shared/withholding` (bug found by the new vectors, fixed 1.6.0).
- **Receipt**: each line carries `statutoryType` / `statutoryRatePercent` / `statutoryVatExempt` → the shared layout
  prints one "Less 10% Solo Parent Discount" row per type; Solo Parent prints "SP Booklet No" + "Child: <name>"; several
  cards print one block per further card (type, ID, Name, Signature). The web's `SalesReceipt.tsx` doesn't render
  `statutory_cards` yet (screens branch) — the device's rendering follows the layout comment in `receipt-layout.ts`.

## Self-test

`../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json scripts/statutory-selftest.ts` (or
`npx tsx …`): bootstrap rules, card checks, line → card, the contract's NAAC example (120.00 − 24.00 = 96.00, VAT 10.29),
Solo Parent 10 %, two cards, payload shapes (incl. older server), reprint = cart, promo vs card. Also updated:
`vat-vectors-selftest.ts` / `withholding-vectors-selftest.ts` pass the vectors' `statutoryRate` / `statutoryVatExempt`.

## Release

Backend first (bootstrap `statutory_discounts`, catalog `solo_parent_eligible`). This build works against an older
server (Senior / PWD only, unchanged payload). An older APK against the new server sells Senior / PWD only (as before).
Raise `min_app_version` to 1.6.0 once the fleet runs it if NAAC / Solo Parent must be sellable on every tablet.
