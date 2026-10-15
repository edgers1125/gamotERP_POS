# Real-time channel — notes for Claude

Core rules: ../../CLAUDE.md (read first). Paths are relative to the repo root (gamotERP_POS).

## File map

- `src/sync/realtime.ts` — the WebSocket (`/pos/realtime`, notices only), owned by `syncEngine`
- `src/sync/syncEngine.ts` — wanted-state, `hello`/`state`/`changed` handling, polling fallback, `useSyncStatus().live`
- `src/api/client.ts` — `deviceAuthHeaders` for the handshake
- `src/db/localStore.ts` — `meta.bootstrap_version`, `meta.approvers_version` (`saveBootstrap`)
- `src/display/displayService.ts` — refreshed on a `display` notice

### Real-time channel (`src/sync/realtime.ts`, `GamotERP/apps/pharma/docs/plans/pos-realtime-channel.md`)

- A WebSocket to `<server base URL>/pos/realtime` (http→ws, https→wss) carrying **notices only**; data still comes from
  the REST endpoints and every write stays REST (outbox `POST /pos/sync`, refunds). Handshake headers =
  `api/client.ts` `deviceAuthHeaders('GET', <http(s) URL>)` (device token + DPoP proof, htu = the http(s) form).
- `syncEngine` owns it: wanted while enrolled, not revoked, no update required, network up, app in the foreground
  (closed in the background). Open → `hello` (app version, pending ops, cached catalog / display / approvers
  versions); `state` → applied like a heartbeat reply, then whatever version differs is fetched; `changed` → catalog
  download / `displayService.refresh()` / the three approver lists (needs an online cashier — deferred until one exists,
  version kept in `meta.approvers_version`) / bootstrap (`terminal`). `status` frame when the outbox count changes (1/s).
- **Terminal version** = bootstrap's `bootstrap_version`, stored in `meta.bootstrap_version` by `saveBootstrap` (null
  when the server sent none; cleared on (re-)enroll) and sent as `hello.versions.terminal`. `state`: re-read bootstrap
  when it differs from the server's; if either side is null, the old "re-read once after a real outage" rule applies.
  `changed` 'terminal': re-read unless the stored version equals the notice's (a null version always re-reads). A
  bootstrap re-read bumps `lastSyncAt` (so `usePosData`/receipts re-read it) and fetches the receipt logo by checksum.
- **While connected (`useSyncStatus().live`) there is no heartbeat and no 15-min bootstrap polling.** When it is down,
  the old polling runs unchanged as the fallback. Manual "Sync now" (`syncNow({ checkVersions: true })`) always
  re-checks catalog (heartbeat) + display + approvers.
- Keep-alive: RN never surfaces ping frames to JS (and its `ws.ping()` sends a BINARY frame — never use it), so any
  server message resets a 90 s idle timer; on expiry the socket is recycled at once (cheap: catch-up fetches nothing).
  Backoff 1 s → 60 s exponential with jitter; close 1012/1011 → random 5–30 s first; 1013 (server's hello throttle) → usual backoff. Close 4001 → revoked, 4026 → update required, 4400 → logged + backoff.
