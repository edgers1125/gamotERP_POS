# License lease — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/license/lease.ts` — pure verify / evaluate
- `src/license/licenseKeys.ts` — pinned keys; `src/license/licenseEval.ts` — "now" + floor
- `src/license/license.ts` — stores check-in results; `src/license/licenseEvents.ts`
- `src/db/policy.ts` — selling-block rules (the license is one of them)
- `src/db/localStore.ts` — SQLCipher meta table (`license`, `license_floor_ms`, `last_check_in_at`)
- `scripts/license-selftest.ts` — self-test
- `src/screens/SyncStatusScreen.tsx` — the "Check-in" screen

### License lease (`src/license/`, `GamotERP/apps/pharma/docs/plans/` POS license plan, Part C)

- Every check-in (device token, heartbeat, bootstrap) can carry `license` = `{ state, lease, … }`. `lease` is a compact
  JWS (`alg EdDSA`, `typ pos-license+jwt`, `kid`) over `{ v:1, kid, company_id, terminal_id, device_id, state OK|OVERDUE,
  issued_at, valid_until }`. The app verifies it with **pinned** keys only (`licenseKeys.ts`, `@noble/curves` ed25519,
  strict `zip215: false` like node:crypto); the bootstrap's `license_public_keys` are trusted in `__DEV__` builds only.
- Stored in the SQLCipher meta table: `license` (record: seen / locked / newest verified lease / last display fields),
  `license_floor_ms` (last trusted server time) and `last_check_in_at`. A new lease replaces the stored one only if it
  verifies and is newer; its `issued_at` resets the floor. Re-enroll drops lease + lock but keeps `seen` and the floor.
- "Now" = max(server-clock estimate, floor, in-session monotonic time) — rolling the device clock back can't revive an
  expired lease. Selling stops when LOCKED (403 `SUBSCRIPTION_LOCKED`, realtime close 4402, or `license.state`) or
  when a lease is missing/expired once any `license` was ever seen. Never seen → not enforced (rollout grace).
  Warnings (not blocking): OVERDUE, and within 7 days of `valid_until`. While locked, realtime and catalog pause.
- **Decision:** a release build with `PRODUCTION_LICENSE_KEYS` empty enforces **only LOCKED** (code `NO_KEYS`), so a
  build shipped without the key can't stop every tablet. Pin the production key before release: run
  `prisma/pos-license-selftest.ts` on the server (last line prints kid + jwk.x), or derive x from the PEM. Rotation:
  pin old + new, ship, then switch the server key.
- Self-test (no device/server): `../GamotERP/apps/pharma/backend/node_modules/.bin/tsx --tsconfig ./tsconfig.json
  scripts/license-selftest.ts` — signs leases with a throwaway key and checks every rule; exit 0 = all passed.
- **Wording:** cashier-facing text says **"check in" / "Check-in"** and **"unsent"** — never "sync" / "synced" /
  "waiting to sync". (Code identifiers — `syncEngine`, `sync_status`, `SyncStatusScreen` — keep their names.)
