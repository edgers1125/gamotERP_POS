# Customer display — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `modules/pos-display/` — `index.ts`, `src/PosDisplayModule.ts` (JS API), `src/PosDisplay.types.ts`
- `modules/pos-display/android/src/main/java/com/medsource/gamoterp/posdisplay/` — `CustomerPresentation.kt` (the Presentation + views), `PosDisplayModule.kt`
- `src/display/` — `displayService.ts` (GET /pos/display + images, offline cache, `displayColors`), `customerDisplay.ts` (cart → display), `useCustomerDisplay.ts` (mounted once in App.tsx)
- `src/sync/syncEngine.ts` — calls `displayService.refresh()` after every bootstrap refresh
- `src/ui/theme.ts` — neutral palette sent to the display
- `src/screens/` — `SellScreen.tsx`, `PaymentScreen.tsx`, `ReceiptScreen.tsx` feed the display

### Customer display (second monitor, `modules/pos-display`, `src/display/`)

The tablet drives a monitor over HDMI / USB-C facing the customer. Native, not a second React root: an
`android.app.Presentation` on the first `DISPLAY_CATEGORY_PRESENTATION` display, laid out with plain Android views
(`CustomerPresentation.kt`); JS only sends what to show. Every string (money included) is formatted in JS — the Kotlin
does no maths.

- **Cart has lines** (Sell → Payment): LEFT half = brand on the BACKDROP (MedSource deep blue #033f74 for the standard
  brand, else the brand's own primary) — the logo with a thin white contour that traces its alpha shape (no white card;
  `outlinedLogo`: white SRC_IN silhouettes stamped around it, ~3 px), name in ivory, accent bar (MedSource green
  #7ab537, or the brand's own secondary) and a thin accent strip down its inner edge (along the bottom when the brand is
  full-screen); RIGHT half = a darker panel (backdrop 30% towards black) with each line (name, qty × unit price, amount,
  item / Senior-PWD discount), then the same rows as `TotalsSummary` (plus "Less: Withholding tax" when billing a company with withholding — the large box then reads AMOUNT DUE = grand total − withholding instead of TOTAL) and a "due" box with a large TOTAL in the accent
  (+ cash received / change). Contrast is enforced natively (ivory on backdrop ≥ 7:1, muted / accent text ≥ 4.5:1). Figures come only from `cartTotals` (shared pricing). Client = first name only.
  On Payment, cash received + change once the cash line is valid (`customerDisplay.setPayment`).
- **Sale completed** (Receipt screen, fresh sale only — not reprints/voids): "Thank you" + total/change/receipt no. for
  8 s, then back to the cart state; the next customer's first item ends it early.
- **Empty cart**: the branch's ads full-screen, each for its `duration_seconds`; no ads (or none decodable) → the brand
  full-screen. Also shown while the till is locked.
- JS API (`modules/pos-display/src/PosDisplayModule.ts`): `isAvailable()`, `setConfig(json)`, `showCart(json)`,
  `showThankYou(json)`, `showIdle()`, event `onDisplayChange {available}`, plus the file cache `saveImage`,
  `imagePath`, `pruneImages`, `readConfigCache`, `writeConfigCache`. The module keeps the last config + screen and
  re-renders them itself on hot-plug / Activity resume; it dismisses the Presentation when the app goes to the
  background or the Activity is destroyed. Without a second display (or in Expo Go, where the module is absent)
  every call is a no-op.
- **Config** (contract "Customer display", device auth, no cashier): `displayService.refresh()` runs after every
  bootstrap refresh in `syncEngine` (startup, after enrollment, every ~15 min while polling) and on a real-time
  `display` notice / `state` mismatch. Same `version` + files present → no
  download; otherwise each image is fetched only if no file with its checksum exists (files are named by checksum),
  then the config is cached (`filesDir/customer_display/config.json`), pushed, and unused files pruned. A failure keeps
  the previous cache. At startup the cache is pushed first, so it works fully offline.
- Colours: the brand's from the server; the neutral palette (ivory, text, muted, success, border) is sent from
  `src/ui/theme.ts`, plus `displayBackground` / `accent` (`displayColors` in `displayService.ts`: a standard primary
  → MedSource blue + green). Flat colours only. Fonts: the Poppins faces expo-font registered (via `ReactFontManager`), else sans-serif. Text sizes
  scale with the monitor's height.
