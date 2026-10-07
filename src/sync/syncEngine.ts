// P-A2 — the outbox sync engine (contract: src/contracts.ts `SyncEngine`, `SyncStatus`).
//
// * Online = NetInfo says connected AND the API actually answered (NetInfo's own "internet reachable" probe is NOT
//   used: the backend may be on a LAN with no internet).
// * While online: POST /pos/sync every ~5 s (and right after a sale/void is queued), ≤ 50 ops per call, oldest first
//   (outbox insertion order); RECORDED / DUPLICATE → done, REJECTED → kept and counted in `rejected`.
// * Heartbeat every ~60 s (pending count + oldest pending time); bootstrap every ~15 min; the catalog is re-downloaded
//   whenever the server's catalog_version (sync / heartbeat / bootstrap) differs from the cached one.
// * 401 DEVICE_REVOKED → `revoked` (persisted, blocks selling); 426 → `updateRequired` (persisted, blocks selling).
// * Errors back off exponentially (5 s … 5 min). An op is never dropped: a failed batch stays PENDING and is retried.
//   The one exception to "retry forever" is a 400 the server gives for a SINGLE op (it can never be accepted as sent):
//   that op is marked REJECTED locally — still kept, still shown — so it can't block every later sale.
// * 413 (batch over the server's JSON body limit): the batch is halved and resent at once, down to one op; a single op
//   still 413 is marked REJECTED locally exactly like the 400 case. The smaller size holds until the outbox drains.
// * `blockedReason` (revoked / update / subscription locked / license lease / the terminal's offline limits) is
//   recomputed every cycle, with the non-blocking `licenseWarning` / `offlineWarning` banners.
// * License lease (src/license/license.ts): every check-in's `license` (device token, heartbeat, bootstrap) is stored
//   by the license module, which the engine starts; while the subscription is LOCKED the catalog and the real-time
//   socket are not attempted (refused with 403) — heartbeat / bootstrap polling and the outbox continue.
// * Real-time channel (src/sync/realtime.ts, docs/plans/pos-realtime-channel.md): wanted while enrolled, not revoked,
//   no update required, not subscription-locked, network up and the app in the foreground. While it is CONNECTED (`live`) the heartbeat and
//   the 15-min bootstrap polling are skipped — the server's `state` / `changed` notices drive the refreshes instead
//   (catalog → catalog download, display → displayService.refresh, approvers → the three lists, terminal →
//   bootstrap, compared against the stored `bootstrap_version`). When it drops, today's polling resumes as the fallback (first heartbeat ~60 s after the drop).
//   Outbox pushing (POST /pos/sync) is the same either way.
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';

import type {
  PosApprovalKind,
  PosCounters,
  RealtimeChanged,
  RealtimeHello,
  RealtimeState,
  SyncOp,
  SyncOpResult,
  SyncResponse,
} from '@pos-api/contract';

import { ATTENDANCE_ONLY_CATALOG_VERSION } from '@pos-api/contract';

import { api, appVersion } from '../api/client';
import { isAttendanceOnlyTerminal, pushPunches, refreshKiosk } from '../attendance/attendanceKiosk';
import { cashierSession } from '../auth/cashierSession';
import type { SyncEngine, SyncStatus } from '../contracts';
import { onLocalStoreEvent } from '../db/events';
import { displayService } from '../display/displayService';
import { ensureReceiptLogo } from '../sale/receiptAssets';
import { localStore } from '../db/localStore';
import { APP_VERSION, compareVersions, licenseWarningMessage, REVOKED_MESSAGE, UNKNOWN_MIN_VERSION } from '../db/policy';
import { license } from '../license/license';
import { realtime, type RealtimeConnection } from './realtime';

// ---- realtime notice listeners (for modules this file can't import without a cycle, e.g. brand theming) --------------
const realtimeNoticeListeners = new Set<(kind: RealtimeChanged['kind']) => void>();
/** Called for every realtime `changed` notice (before it's handled). Returns an unsubscribe function. */
export function onRealtimeNotice(listener: (kind: RealtimeChanged['kind']) => void): () => void {
  realtimeNoticeListeners.add(listener);
  return () => realtimeNoticeListeners.delete(listener);
}

const SYNC_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000; // not enrolled / revoked: only watch for re-enrollment
const HEARTBEAT_INTERVAL_MS = 60_000;
const BOOTSTRAP_REFRESH_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_CYCLE = 20;
const APPROVERS_RETRY_MS = 60_000; // a deferred approvers refresh (no online cashier yet) is retried at most this often
const APPROVAL_KINDS: PosApprovalKind[] = ['DISCOUNT', 'VOID', 'REFUND'];

const INITIAL_STATUS: SyncStatus = {
  online: false,
  syncing: false,
  pending: 0,
  oldestPendingAt: null,
  lastSyncAt: null,
  lastError: null,
  rejected: 0,
  revoked: false,
  updateRequired: null,
  blockedReason: null,
  subscriptionLocked: false,
  licenseWarning: null,
  offlineWarning: null,
  license: null,
  live: false,
  realtime: 'off',
};

/** Zustand hook: `useSyncStatus()` / `useSyncStatus((s) => s.online)`; `useSyncStatus.getState()` outside React. */
export const useSyncStatus = create<SyncStatus>()(() => INITIAL_STATUS);
const setStatus = (patch: Partial<SyncStatus>) => useSyncStatus.setState(patch);

// ---- engine state -------------------------------------------------------------------------------------------------

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeNet: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let appStateSub: NativeEventSubscription | null = null;

let netConnected: boolean | null = null; // NetInfo; null = unknown (try anyway)
let reachable: boolean | null = null; // did the API answer the last call? null = not tried since (re)connecting
let failures = 0;
let lastHeartbeatAt = 0;
let lastBootstrapAt = 0;
let catalogStale = false;
// An ATTENDANCE_ONLY terminal (docs/plans/attendance-pos-only.md): no catalog (the server reports
// ATTENDANCE_ONLY_CATALOG_VERSION and never needs one downloaded) and no customer display. Learnt from each bootstrap.
let attendanceOnlyTerminal = false;
let isolateNext = false; // after a whole-batch 400: send one op at a time to find the one the server refuses
let sizeLimit = BATCH_SIZE; // after a 413: halved until a batch fits; back to BATCH_SIZE once the outbox is empty

let cycle: Promise<void> | null = null;
let rerun = false;
let catalogJob: Promise<void> | null = null;
let idle = false; // last cycle found nothing to do on the network (not enrolled / revoked)
let foreground = AppState.currentState !== 'background';
let forceCheck = false; // manual "Sync now": also check the catalog / display / approvers versions this cycle
// (Re)connected after a real outage: re-read bootstrap once — only used when the terminal version can't be compared
// (older server without `versions.terminal`, or no `bootstrap_version` cached yet).
let bootstrapOnConnect = true;
let approversTarget: string | null = null; // server's approvers version not fetched yet (waits for an online cashier)
let approversTriedAt = 0;

// ---- errors -------------------------------------------------------------------------------------------------------

// Duck-typed (not instanceof): a transpiled `class extends Error` doesn't always keep its prototype.
interface ApiErrorLike {
  status: number;
  message: string;
  code: string | null;
  minAppVersion?: unknown; // api/client.ts AppUpdateRequiredError
}
function asApiError(e: unknown): ApiErrorLike | null {
  if (e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number') return e as ApiErrorLike;
  return null;
}
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

/** Records what an error means for the device (revoked / update / unreachable) and the status line. */
async function noteError(e: unknown): Promise<void> {
  const err = asApiError(e);
  if (err?.status === 401 && err.code === 'DEVICE_REVOKED') {
    reachable = true;
    await localStore.setRevoked(true);
    setStatus({ revoked: true, online: true, lastError: REVOKED_MESSAGE });
    return;
  }
  if (err?.status === 426) {
    reachable = true;
    const fromError = typeof err.minAppVersion === 'string' && err.minAppVersion ? err.minAppVersion : null;
    const fromTerminal = (await localStore.getBootstrap().catch(() => null))?.terminal.min_app_version ?? null;
    const min = fromError ?? (fromTerminal && compareVersions(APP_VERSION, fromTerminal) < 0 ? fromTerminal : null);
    await localStore.setUpdateRequired(min ?? UNKNOWN_MIN_VERSION);
    setStatus({ online: true, lastError: err.message || 'App update required' });
    return;
  }
  if (!err || err.status === 0) {
    // status 0 = network failure / timeout (ApiError.isNetwork); a non-ApiError is most likely a fetch TypeError.
    if (!err && !(e instanceof TypeError)) {
      setStatus({ lastError: messageOf(e) });
      return;
    }
    reachable = false;
    setStatus({ online: false, lastError: `Server unreachable: ${messageOf(e)}` });
    return;
  }
  reachable = true; // the server answered, just not happily
  setStatus({ online: netConnected !== false, lastError: `${err.status}: ${err.message}` });
}

// ---- status -------------------------------------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  try {
    const pending = await localStore.pendingCount();
    const rejected = await localStore.rejectedCount();
    const flags = await localStore.getFlags();
    const blockedReason = await localStore.sellingBlockedReason();
    const lic = await localStore.licenseStatus();
    const offline = await localStore.offlineWarning();
    // Real-time `status` frame when the outbox count changed (the client dedupes + throttles to 1/s).
    realtime.reportPending(pending.count, pending.oldestAt);
    setStatus({
      pending: pending.count,
      oldestPendingAt: pending.oldestAt,
      rejected,
      revoked: flags.revoked,
      updateRequired: flags.updateRequired,
      blockedReason,
      subscriptionLocked: lic.evaluation.code === 'LOCKED',
      licenseWarning: lic.evaluation.code === 'VALID' ? licenseWarningMessage(lic.evaluation.warn, lic.evaluation.validUntilMs) : null,
      offlineWarning: offline,
      license: {
        code: lic.evaluation.code,
        state: lic.evaluation.state,
        validUntil: lic.evaluation.validUntilMs !== null ? new Date(lic.evaluation.validUntilMs).toISOString() : null,
        detail: lic.evaluation.detail,
      },
      online: netConnected !== false && reachable === true,
    });
  } catch (e) {
    setStatus({ lastError: `Local database: ${messageOf(e)}` });
  }
}

// Last successful server contact, persisted for the "not checked in for N h" banner — written at most once a minute.
const CHECK_IN_PERSIST_MS = 60_000;
let checkInPersistedAt = 0;
async function noteCheckIn(): Promise<void> {
  if (Date.now() - checkInPersistedAt < CHECK_IN_PERSIST_MS) return;
  checkInPersistedAt = Date.now();
  await localStore.setLastCheckInAt(new Date().toISOString()).catch(() => undefined);
}

// ---- server facts shared by sync / heartbeat / bootstrap ----------------------------------------------------------

async function applyServerFacts(counters: PosCounters, catalogVersion: string): Promise<void> {
  // Never lowers: the server's expected numbers only matter if they are AHEAD (numbers it already saw used).
  await localStore.raiseCounters(counters);
  if (catalogVersion === ATTENDANCE_ONLY_CATALOG_VERSION) return; // nothing to download
  const have = await localStore.getCatalogVersion();
  if (have !== catalogVersion) catalogStale = true;
}

async function applyMinAppVersion(min: string | null): Promise<void> {
  if (min && compareVersions(APP_VERSION, min) < 0) {
    await localStore.setUpdateRequired(min);
  } else if ((await localStore.getFlags()).updateRequired) {
    await localStore.setUpdateRequired(null);
  }
}

// ---- the three server exchanges -----------------------------------------------------------------------------------

/** Keeps a single op the server can never accept as sent — visibly, as REJECTED — so it can't block every later op. */
async function rejectLocally(op: SyncOp, error: string): Promise<void> {
  const rejected: SyncOpResult = {
    client_uuid: op.client_uuid,
    status: 'REJECTED',
    batch_id: null,
    reference: null,
    invoice_number: null,
    stock_status: null,
    exceptions: [],
    error,
  };
  await localStore.applyResults([rejected]);
}

/** Sends the outbox; returns true if the server was contacted. Throws on a failed call (ops stay PENDING). */
async function pushOutbox(): Promise<boolean> {
  let contacted = false;
  let batches = 0;
  while (batches < MAX_BATCHES_PER_CYCLE) {
    const limit = isolateNext ? 1 : sizeLimit;
    const ops: SyncOp[] = await localStore.pendingOps(limit);
    if (!ops.length) {
      isolateNext = false;
      sizeLimit = BATCH_SIZE; // queue drained: the next backlog starts at full size again
      return contacted;
    }
    const uuids = ops.map((o) => o.client_uuid);
    let res: SyncResponse;
    try {
      res = await api.sync(ops);
    } catch (e) {
      const err = asApiError(e);
      if (err?.status === 413 && ops.length > 1) {
        // Body over the server's JSON limit (express {code:'PAYLOAD_TOO_LARGE'} or nginx's HTML page): halve the batch
        // and resend now — no backoff, nothing was recorded. Bounded: the size strictly shrinks down to one op.
        sizeLimit = Math.max(1, Math.floor(ops.length / 2));
        contacted = true;
        reachable = true;
        continue;
      }
      if ((err?.status === 400 || err?.status === 413) && ops.length === 1) {
        // The server can't accept this op as sent (malformed, or too large on its own) — keep it, visibly, as REJECTED
        // instead of blocking the queue.
        const why = err.status === 413 ? 'too large for the server to accept' : err.message;
        await rejectLocally(ops[0]!, `Refused by the server: ${why}`);
        isolateNext = false;
        contacted = true;
        reachable = true;
        batches++;
        continue;
      }
      if (err?.status === 400 && ops.length > 1) isolateNext = true;
      await localStore.markAttempt(uuids, messageOf(e)).catch(() => undefined);
      throw e;
    }
    batches++;
    contacted = true;
    reachable = true;
    isolateNext = false;
    // REJECTED results (incl. an op the server gave up on after repeated failures) are stored as REJECTED — out of
    // the PENDING queue, so the ops after them keep flowing.
    await localStore.applyResults(res.results);
    const answered = new Set(res.results.map((r) => r.client_uuid));
    const unanswered = uuids.filter((u) => !answered.has(u));
    if (unanswered.length) await localStore.markAttempt(unanswered, 'No result from the server for this op');
    await applyServerFacts(res.server_counters, res.catalog_version);
    // Stop early if the server skipped some (retry next cycle) or this was the last (partial) batch.
    if (unanswered.length || ops.length < limit) break;
  }
  return contacted;
}

async function heartbeat(): Promise<void> {
  const p = await localStore.pendingCount();
  const hb = await api.heartbeat({ pending_ops: p.count, oldest_pending_at: p.oldestAt, app_version: APP_VERSION });
  lastHeartbeatAt = Date.now();
  reachable = true;
  await applyMinAppVersion(hb.min_app_version);
  await applyServerFacts(hb.server_counters, hb.catalog_version);
}

/** GET /pos/bootstrap (always), then GET /pos/catalog when forced or the version differs from the cached one. */
async function refreshBootstrapAndCatalog(force: boolean): Promise<void> {
  const b = await api.bootstrap();
  reachable = true;
  await localStore.saveBootstrap(b); // also stores b.bootstrap_version (real-time `versions.terminal`)
  lastBootstrapAt = Date.now();
  // Screens holding the bootstrap (usePosData → receipts: settings, POS provider, branch/TIN, payment methods) re-read on
  // `lastSyncAt`; a re-read started by a real-time notice runs outside the cycle, which would never bump it.
  setStatus({ lastSyncAt: new Date().toISOString() });
  // The receipt logo, only when its checksum is new (fire-and-forget; never fails a sync cycle). A newly saved logo
  // bumps `lastSyncAt` again so an open receipt picks it up.
  void ensureReceiptLogo(b).then((saved) => {
    if (saved) setStatus({ lastSyncAt: new Date().toISOString() });
  });
  await applyMinAppVersion(b.terminal.min_app_version);
  await localStore.raiseCounters(b.server_counters);
  attendanceOnlyTerminal = isAttendanceOnlyTerminal(b.terminal) || b.catalog_version === ATTENDANCE_ONLY_CATALOG_VERSION;
  const have = await localStore.getCatalogVersion();
  if (attendanceOnlyTerminal) {
    catalogStale = false; // no catalog to sell from
  } else if (force || have !== b.catalog_version) {
    let c: Awaited<ReturnType<typeof api.catalog>> | null = null;
    try {
      c = await api.catalog();
    } catch (e) {
      // A LOCKED company is refused the catalog (403 SUBSCRIPTION_LOCKED) but its check-in (this bootstrap) worked:
      // keep the cached catalog (selling is blocked anyway) and retry once the lock is gone — not a failed cycle.
      if (asApiError(e)?.code !== 'SUBSCRIPTION_LOCKED') throw e;
    }
    if (c) await localStore.saveCatalog(c);
    catalogStale = c === null;
  } else {
    catalogStale = false;
  }
  // The customer display's brand/ads ride along (startup, after enrollment, every ~15 min). Fire-and-forget: it never
  // throws and never holds up or fails a sync cycle; offline it keeps showing its cache. None on an attendance-only tablet.
  if (!attendanceOnlyTerminal) void displayService.refresh();
  // Attendance kiosk on/off + employee list (no bootstrap field says it — GET /pos/attendance/kiosk does). Never throws.
  void refreshKiosk({ force: true });
}

function refreshCatalogOnce(force: boolean): Promise<void> {
  if (!catalogJob) {
    catalogJob = refreshBootstrapAndCatalog(force).finally(() => {
      catalogJob = null;
    });
  } else if (force) {
    // A refresh is already running; run a forced one right after it.
    return catalogJob.catch(() => undefined).then(() => refreshCatalogOnce(true));
  }
  return catalogJob;
}

/** Re-fetches the three co-signer lists (DISCOUNT / VOID / REFUND) into the cache. GET /pos/approvers needs an online
 * cashier session: without one the refresh waits (`approversTarget`) and is retried by the cycle. `force` (manual
 * Sync now) fetches even when no newer server version is known. Never throws. */
async function refreshApprovers(force: boolean): Promise<void> {
  if (!force && approversTarget === null) return;
  if (!cashierSession.isOnlineSession()) return;
  const target = approversTarget;
  approversTriedAt = Date.now();
  try {
    for (const kind of APPROVAL_KINDS) {
      const list = await api.approvers(kind);
      await localStore.saveApprovers(kind, list);
    }
    if (target !== null) {
      await localStore.setApproversVersion(target);
      if (approversTarget === target) approversTarget = null;
    }
  } catch {
    // Keep the cache; retried later (cycle) or on the next notice.
  }
}

// ---- real-time channel handlers (src/sync/realtime.ts) --------------------------------------------------------------

/** Runs a refresh started by a notice; failures are recorded like any sync error (never thrown). */
function runRefresh(job: () => Promise<unknown>): Promise<void> {
  return job()
    .then(() => undefined)
    .catch(async (e) => {
      await noteError(e).catch(() => undefined);
      await refreshStatus();
    });
}

async function refreshCatalogIfDifferent(serverVersion: string | null): Promise<void> {
  if (serverVersion === null || serverVersion === ATTENDANCE_ONLY_CATALOG_VERSION) return;
  if ((await localStore.getCatalogVersion()) === serverVersion) return;
  await runRefresh(() => refreshCatalogOnce(true));
}

async function refreshDisplayIfDifferent(serverVersion: string | null): Promise<void> {
  if (!displayService.supported || attendanceOnlyTerminal) return;
  if (serverVersion !== null && (await displayService.cachedVersion()) === serverVersion) return;
  await displayService.refresh();
}

async function refreshApproversIfDifferent(serverVersion: string | null): Promise<void> {
  if (serverVersion === null) return;
  if ((await localStore.getApproversVersion().catch(() => null)) === serverVersion) {
    approversTarget = null;
    return;
  }
  approversTarget = serverVersion;
  await refreshApprovers(false);
}

/** A real-time `versions.terminal` / 'terminal' notice version, read defensively (an older server has no such field). */
function terminalVersionOf(v: string | null | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Re-reads bootstrap (terminal + receipt settings, POS provider, branch/TIN, sales staff… and the receipt logo by
 * checksum; the catalog too when its version differs) unless the cached one already matches `serverVersion`. A null
 * `serverVersion` (unknown) always re-reads. If a re-read was already running (it may have started before the change),
 * one more is run when the cache still doesn't match. */
async function refreshBootstrapIfDifferent(serverVersion: string | null): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (serverVersion !== null && (await localStore.getBootstrapVersion().catch(() => null)) === serverVersion) return;
    await runRefresh(() => refreshCatalogOnce(false));
    // Only a server that sends `bootstrap_version` can confirm the cache now matches; otherwise one re-read is all.
    if (serverVersion === null || (await localStore.getBootstrapVersion().catch(() => null)) === null) return;
  }
}

realtime.configure({
  async hello(): Promise<RealtimeHello> {
    const p = await localStore.pendingCount();
    return {
      type: 'hello',
      app_version: appVersion(),
      pending_ops: p.count,
      oldest_pending_at: p.oldestAt,
      versions: {
        catalog: await localStore.getCatalogVersion().catch(() => null),
        display: await displayService.cachedVersion(),
        approvers: await localStore.getApproversVersion().catch(() => null),
        terminal: await localStore.getBootstrapVersion().catch(() => null),
      },
    };
  },

  async onState(state: RealtimeState) {
    // Exactly what the heartbeat reply is applied with (min app version, counters; catalog version below).
    reachable = true;
    if (state.update_required) await localStore.setUpdateRequired(state.min_app_version ?? UNKNOWN_MIN_VERSION);
    else await applyMinAppVersion(state.min_app_version);
    await localStore.raiseCounters(state.server_counters);
    setStatus({ lastError: null });
    await refreshStatus();
    if (state.update_required) return; // the server closes with 4026 next
    // Terminal/receipt settings: compare versions when both sides have one; otherwise (older server with no
    // `versions.terminal`, or a cached bootstrap from before `bootstrap_version`) fall back to re-reading bootstrap
    // once after a real outage, since changes made meanwhile may have gone unnoticed.
    const serverTerminal = terminalVersionOf(state.versions.terminal);
    const haveTerminal = await localStore.getBootstrapVersion().catch(() => null);
    const reReadBootstrap =
      serverTerminal !== null && haveTerminal !== null
        ? serverTerminal !== haveTerminal
        : bootstrapOnConnect && Date.now() - lastBootstrapAt >= HEARTBEAT_INTERVAL_MS;
    bootstrapOnConnect = false;
    if (reReadBootstrap) {
      // Bootstrap also downloads the catalog when its version differs (and refreshes the receipt logo by checksum).
      await runRefresh(() => refreshCatalogOnce(false));
    } else {
      await refreshCatalogIfDifferent(state.versions.catalog);
    }
    await refreshDisplayIfDifferent(state.versions.display);
    await refreshApproversIfDifferent(state.versions.approvers);
  },

  async onChanged(msg: RealtimeChanged) {
    // Brand theming (src/ui/brandSource.ts) listens here — it imports this file, so it subscribes rather than being
    // imported (no cycle). 'display' = the terminal's brand/ads; 'terminal' also covers cashier-brand changes.
    for (const l of realtimeNoticeListeners) {
      try {
        l(msg.kind);
      } catch {
        // a listener's failure never affects sync
      }
    }
    switch (msg.kind) {
      case 'catalog':
        await refreshCatalogIfDifferent(msg.version);
        break;
      case 'display':
        await refreshDisplayIfDifferent(msg.version);
        break;
      case 'approvers':
        await refreshApproversIfDifferent(msg.version);
        break;
      case 'terminal':
        // Skipped only when the cached bootstrap provably matches; a notice without a version always re-reads.
        await refreshBootstrapIfDifferent(terminalVersionOf(msg.version));
        break;
    }
  },

  async onRevoked() {
    // Same as the REST 401 DEVICE_REVOKED path.
    await noteError({ status: 401, code: 'DEVICE_REVOKED', message: REVOKED_MESSAGE });
    await refreshStatus();
  },

  async onUpdateRequired(min: string | null) {
    // Same as the REST 426 path.
    await noteError({ status: 426, code: 'APP_UPDATE_REQUIRED', message: 'App update required', minAppVersion: min });
    await refreshStatus();
  },

  onConnectionChange(conn: RealtimeConnection, lost: boolean) {
    const wasLive = useSyncStatus.getState().live;
    setStatus({ live: conn === 'connected', realtime: conn });
    if (wasLive && conn !== 'connected') {
      // Fallback polling resumes as if the socket's last contact had been a poll: first heartbeat ~60 s from now.
      lastHeartbeatAt = Date.now();
      lastBootstrapAt = Date.now();
      if (lost) bootstrapOnConnect = true;
    }
  },
});

// ---- the cycle ----------------------------------------------------------------------------------------------------

/** One pass. Returns false when a server call failed (→ back off). Never throws. */
async function runCycle(): Promise<boolean> {
  try {
    await localStore.init();
    const enrollment = await localStore.getEnrollment();
    const flags = await localStore.getFlags();
    idle = !enrollment || flags.revoked;
    // Subscription locked: the realtime handshake and the catalog are refused (403) until it is paid — check in by
    // heartbeat / bootstrap polling meanwhile (their `license` says when it is unlocked).
    const locked = (await localStore.getLicenseRecord().catch(() => null))?.locked === true;
    realtime.setWanted(started && !idle && !flags.updateRequired && !locked && netConnected !== false && foreground);
    if (idle) return true;
    if (netConnected === false) {
      reachable = null;
      return true;
    }

    setStatus({ syncing: true });
    let contacted = false;
    const check = forceCheck;
    forceCheck = false;
    // Heartbeat FIRST on (re)connect: it reports this app's version, which the server's 426 check reads — an updated
    // app must be recorded before its first sync, or that sync is refused as 'update required'. While the real-time
    // socket is live its hello already did that (and its notices replace the polling), so no heartbeat then — except
    // for a manual "Sync now", which always re-checks the catalog version this way.
    if (check || (!realtime.isLive() && (reachable !== true || Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS))) {
      await heartbeat();
      contacted = true;
    }
    const afterHeartbeat = await localStore.getFlags();
    if (!afterHeartbeat.updateRequired) contacted = (await pushOutbox()) || contacted;
    // Attendance punches (src/attendance/attendanceKiosk.ts): their own queue + multipart upload, oldest first.
    if (!afterHeartbeat.updateRequired) contacted = (await pushPunches()) || contacted;
    const now = await localStore.getFlags();
    if (
      !now.updateRequired &&
      !now.revoked &&
      ((catalogStale && !locked) || (!realtime.isLive() && Date.now() - lastBootstrapAt >= BOOTSTRAP_REFRESH_MS))
    ) {
      await refreshCatalogOnce(false);
      contacted = true;
    }
    if (check) {
      // Manual "Sync now": display + approvers are cheap to re-check too (each fetches only what changed / is small).
      await displayService.refresh();
      await refreshApprovers(true);
    } else if (approversTarget !== null && Date.now() - approversTriedAt >= APPROVERS_RETRY_MS) {
      await refreshApprovers(false); // a notice arrived while no cashier was signed in online
    }
    if (contacted) setStatus({ lastError: null, lastSyncAt: new Date().toISOString() });
    // A live real-time socket is server contact too (its hello/state replace the heartbeat).
    if (contacted || realtime.isLive()) await noteCheckIn();
    failures = 0;
    return true;
  } catch (e) {
    await noteError(e).catch(() => undefined);
    failures++;
    return false;
  } finally {
    setStatus({ syncing: false });
    await refreshStatus();
  }
}

function nextDelay(): number {
  if (failures > 0) {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10));
    return base + Math.floor(Math.random() * Math.min(base / 4, 5_000)); // jitter
  }
  if (idle) return IDLE_INTERVAL_MS;
  return SYNC_INTERVAL_MS;
}

function schedule(ms: number): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void kick();
  }, ms);
}

/** Runs a cycle now (single-flight: a request during a running cycle runs one more right after it). */
function kick(): Promise<void> {
  if (cycle) {
    rerun = true;
    return cycle;
  }
  cycle = (async () => {
    let ok = true;
    do {
      rerun = false;
      ok = await runCycle();
    } while (rerun && ok);
  })().finally(() => {
    cycle = null;
    schedule(nextDelay());
  });
  return cycle;
}

// ---- listeners ----------------------------------------------------------------------------------------------------

function onNetChange(state: NetInfoState): void {
  const was = netConnected;
  netConnected = state.isConnected; // boolean | null
  if (netConnected === false) {
    reachable = null;
    realtime.setWanted(false);
    setStatus({ online: false });
    return;
  }
  if (was === false || was === null) {
    // (Re)connected: prove reachability right away instead of waiting out a backoff.
    reachable = null;
    failures = 0;
    void kick();
  }
}

function onAppStateChange(s: AppStateStatus): void {
  if (s === 'active') {
    foreground = true;
    void kick(); // the cycle re-opens the real-time socket (→ catch-up)
  } else if (s === 'background') {
    foreground = false;
    realtime.setWanted(false); // closed in the background; polling rules apply meanwhile
  }
}

// ---- public -------------------------------------------------------------------------------------------------------

export const syncEngine: SyncEngine = {
  start() {
    if (started) return;
    started = true;
    foreground = AppState.currentState !== 'background';
    unsubscribeNet = NetInfo.addEventListener(onNetChange);
    unsubscribeStore = onLocalStoreEvent((ev) => {
      if (ev === 'enqueued') {
        // A sale/void was just committed: send it now (bypasses any backoff wait).
        if (timer) clearTimeout(timer);
        timer = null;
        void kick();
      } else {
        void refreshStatus();
      }
    });
    appStateSub = AppState.addEventListener('change', onAppStateChange);
    // License lease signals (src/license/license.ts): stored, then the status (blockedReason, banners) recomputed.
    license.start(() => {
      void refreshStatus();
    });
    void kick();
  },

  stop() {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribeNet?.();
    unsubscribeNet = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    appStateSub?.remove();
    appStateSub = null;
    license.stop();
    realtime.setWanted(false);
  },

  /** Sync right now (ignores any backoff); `checkVersions` (manual "Sync now") also re-checks the catalog / display /
   * approvers versions. Never throws — the outcome is in useSyncStatus. */
  async syncNow(opts?: { checkVersions?: boolean }) {
    if (opts?.checkVersions) forceCheck = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await kick();
  },

  /** Re-reads bootstrap and (when changed, or `force`) the catalog. Throws on failure (also shown in the status). */
  async refreshCatalog(force = false) {
    try {
      await localStore.init();
      await refreshCatalogOnce(force);
      setStatus({ lastError: null, lastSyncAt: new Date().toISOString() });
    } catch (e) {
      await noteError(e).catch(() => undefined);
      throw e;
    } finally {
      await refreshStatus();
    }
  },
};
