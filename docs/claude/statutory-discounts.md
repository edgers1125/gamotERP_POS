# Statutory discounts (BIR Phase 2 + 2b)

Senior Citizen, PWD, NAAC, Solo Parent, Medal of Valor; several cards per sale when the company allows. Contract:
GamotERP `apps/pharma/docs/plans/bir-statutory-discounts-contract.md`. Rules (rates, VAT, expiry, child age, line -> card)
are the shared `@shared/statutory-rules` + shared pricing; the company's rules come from the cached bootstrap
(`statutoryConfigOf`, cart `statutoryConfig`, frozen per sale like VAT-inclusive).

## File map

| File | Owns |
|---|---|
| `src/sale/statutory.ts` | `StatutoryDraft`, config (`offeredStatutoryTypes`, `statutoryRuleText`), `statutoryProblem`, `clientStatutoryBlock(client, config)`, payload |
| `src/sale/cartMath.ts` (re-exported by `cart.ts`) | `saleCards`, `multiCard`, `lineEligibleFor`, `lineCardOptions`, `lineStatutoryType`, `cardDiscountName`, `statutoryDiscountRows`, `statutoryCardsProblem` |
| `src/components/sale/ClientDialog.tsx` | card 0 (the client's card): "Statutory discount" panel |
| `src/components/sale/SoloParentFields.tsx` | Solo Parent block (booklet no., children list, "prescription is in the child's name") — used by both dialogs |
| `src/components/sale/ExtraCardDialog.tsx` | one further card (add / edit / remove), no phone / sex / address |
| `src/components/sale/CartLineRow.tsx` | per-line card picker, card chip / note, Promo-vs-card choice |
| `src/screens/SellScreen.tsx` | cards listed under the client, "+ Add another card", extra-card rows (Edit) |
| `src/screens/PaymentScreen.tsx` | every card (type + ID), "<card> chosen over the promo" |
| `scripts/statutory-selftest.ts` | maths / rules self-test (65 checks) |

## Screen behaviour

- **ClientDialog**: type choice = None + `offeredStatutoryTypes(cart.statutoryConfig)`, each with `statutoryRuleText` below.
  Expiry field for every type with `statutoryIdHasExpiry` ("Expiry date *" for PWD / Solo Parent, "(optional)" for NAAC /
  MoV, none for Senior). Eligible-item count per type = `lineEligibleFor` (Solo Parent uses `solo_parent_eligible`).
  Solo Parent shows `SoloParentFields`; the Rx attestation switch appears only when a cart line is `rxRequired` and
  Solo-Parent-eligible. A record-matched client's card pre-fills (incl. booklet no.); Solo Parent never auto-applies
  (`clientStatutoryBlock` asks to open the form for the child).
- **Extra cards** (`!statutoryConfig.oneTypePerSale` and card 0 set): "+ Add another card" on the Sell screen offers the
  offered types not yet on the sale; saved through `setExtraCards`. Saving the client's card with a type an extra card
  already has drops that extra card.
- **Per-line picker** (CartLineRow): only when `multiCard(cart)` and the line has `lineCardOptions`; one chip per card +
  "No card"; calls `setLineCard`. Chip / notes use `cardDiscountName(type, rule)`; the promo choice is "Promo or <card>"
  with `scPwdComparison(line, rule.ratePercent)`.
- Keep the user-facing wording "Statutory discount" / the type label; "SC/PWD" stays only on the product-search eligibility badge.
