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
// * `blockedReason` (revoked / update / the terminal's offline limits) is recomputed every cycle.
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';

import type { PosCounters, SyncOp, SyncOpResult, SyncResponse } from '@pos-api/contract';

import { api } from '../api/client';
import type { SyncEngine, SyncStatus } from '../contracts';
import { onLocalStoreEvent } from '../db/events';
import { localStore } from '../db/localStore';
import { APP_VERSION, compareVersions, REVOKED_MESSAGE, UNKNOWN_MIN_VERSION } from '../db/policy';

const SYNC_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000; // not enrolled / revoked: only watch for re-enrollment
const HEARTBEAT_INTERVAL_MS = 60_000;
const BOOTSTRAP_REFRESH_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_CYCLE = 20;

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
let isolateNext = false; // after a whole-batch 400: send one op at a time to find the one the server refuses

let cycle: Promise<void> | null = null;
let rerun = false;
let catalogJob: Promise<void> | null = null;
let idle = false; // last cycle found nothing to do on the network (not enrolled / revoked)

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
    setStatus({
      pending: pending.count,
      oldestPendingAt: pending.oldestAt,
      rejected,
      revoked: flags.revoked,
      updateRequired: flags.updateRequired,
      blockedReason,
      online: netConnected !== false && reachable === true,
    });
  } catch (e) {
    setStatus({ lastError: `Local database: ${messageOf(e)}` });
  }
}

// ---- server facts shared by sync / heartbeat / bootstrap ----------------------------------------------------------

async function applyServerFacts(counters: PosCounters, catalogVersion: string): Promise<void> {
  // Never lowers: the server's expected numbers only matter if they are AHEAD (numbers it already saw used).
  await localStore.raiseCounters(counters);
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

/** Sends the outbox; returns true if the server was contacted. Throws on a failed call (ops stay PENDING). */
async function pushOutbox(): Promise<boolean> {
  let contacted = false;
  for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i++) {
    const ops: SyncOp[] = await localStore.pendingOps(isolateNext ? 1 : BATCH_SIZE);
    if (!ops.length) {
      isolateNext = false;
      return contacted;
    }
    const uuids = ops.map((o) => o.client_uuid);
    let res: SyncResponse;
    try {
      res = await api.sync(ops);
    } catch (e) {
      const err = asApiError(e);
      if (err?.status === 400 && ops.length === 1) {
        // The server can't accept this op as sent — keep it, visibly, as REJECTED instead of blocking the queue.
        const rejected: SyncOpResult = {
          client_uuid: ops[0]!.client_uuid,
          status: 'REJECTED',
          batch_id: null,
          reference: null,
          invoice_number: null,
          stock_status: null,
          exceptions: [],
          error: `Refused by the server: ${err.message}`,
        };
        await localStore.applyResults([rejected]);
        isolateNext = false;
        contacted = true;
        reachable = true;
        continue;
      }
      if (err?.status === 400 && ops.length > 1) isolateNext = true;
      await localStore.markAttempt(uuids, messageOf(e)).catch(() => undefined);
      throw e;
    }
    contacted = true;
    reachable = true;
    isolateNext = false;
    await localStore.applyResults(res.results);
    const answered = new Set(res.results.map((r) => r.client_uuid));
    const unanswered = uuids.filter((u) => !answered.has(u));
    if (unanswered.length) await localStore.markAttempt(unanswered, 'No result from the server for this op');
    await applyServerFacts(res.server_counters, res.catalog_version);
    // Stop early if the server skipped some (retry next cycle) or this was the last (partial) batch.
    if (unanswered.length || ops.length < BATCH_SIZE) break;
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
  await localStore.saveBootstrap(b);
  lastBootstrapAt = Date.now();
  await applyMinAppVersion(b.terminal.min_app_version);
  await localStore.raiseCounters(b.server_counters);
  const have = await localStore.getCatalogVersion();
  if (force || have !== b.catalog_version) {
    const c = await api.catalog();
    await localStore.saveCatalog(c);
  }
  catalogStale = false;
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

// ---- the cycle ----------------------------------------------------------------------------------------------------

/** One pass. Returns false when a server call failed (→ back off). Never throws. */
async function runCycle(): Promise<boolean> {
  try {
    await localStore.init();
    const enrollment = await localStore.getEnrollment();
    const flags = await localStore.getFlags();
    idle = !enrollment || flags.revoked;
    if (idle) return true;
    if (netConnected === false) {
      reachable = null;
      return true;
    }

    setStatus({ syncing: true });
    let contacted = false;
    // Heartbeat FIRST on (re)connect: it reports this app's version, which the server's 426 check reads — an updated
    // app must be recorded before its first sync, or that sync is refused as 'update required'.
    if (reachable !== true || Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      await heartbeat();
      contacted = true;
    }
    const afterHeartbeat = await localStore.getFlags();
    if (!afterHeartbeat.updateRequired) contacted = (await pushOutbox()) || contacted;
    const now = await localStore.getFlags();
    if (!now.updateRequired && !now.revoked && (catalogStale || Date.now() - lastBootstrapAt >= BOOTSTRAP_REFRESH_MS)) {
      await refreshCatalogOnce(false);
      contacted = true;
    }
    if (contacted) setStatus({ lastError: null, lastSyncAt: new Date().toISOString() });
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
  if (s === 'active') void kick();
}

// ---- public -------------------------------------------------------------------------------------------------------

export const syncEngine: SyncEngine = {
  start() {
    if (started) return;
    started = true;
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
  },

  /** Sync right now (ignores any backoff). Never throws — the outcome is in useSyncStatus. */
  async syncNow() {
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
