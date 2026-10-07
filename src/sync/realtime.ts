// Real-time channel client (GamotERP/apps/pharma/docs/plans/pos-realtime-channel.md; contract "Real-time channel").
//
// A WebSocket to `<server base URL>/pos/realtime` that carries NOTICES only ("X changed") — the data is still fetched
// with the REST endpoints, and every write (the outbox, refunds) stays REST. This module is transport only: connect,
// hello, parse, keep-alive, backoff. What a `state` / `changed` means is decided by the sync engine's handlers
// (src/sync/syncEngine.ts owns this client: it says when the socket is wanted and does every refresh).
//
// * Auth = the REST device auth at the handshake: `Authorization: DPoP <device token>` + `DPoP: <proof, htm GET,
//   htu = the http(s) form of the URL>` (api/client.ts `deviceAuthHeaders`). RN's WebSocket sends headers on Android.
// * First frame = `hello` (built by the engine); the server answers `state` → CONNECTED (`live`), backoff reset.
// * Keep-alive: the server pings every 25 s, but React Native never surfaces ping frames to JS (OkHttp answers them
//   natively; RN's own `ws.ping()` sends an empty BINARY message, which the server would take as a protocol error — so
//   it is never used). A 60 s "no frame seen" watchdog would therefore trip on every quiet, healthy link. Instead:
//   any server message resets an idle timer, and after IDLE_RECYCLE_MS (90 s) without one the socket is closed and
//   reopened at once. Cheap by design — the reconnect's hello/state catch-up fetches nothing when versions match — and
//   it bounds how long a silently dead link (Wi-Fi drop without a FIN) can go unnoticed. If the server ever sends a
//   periodic text frame, the recycling simply stops happening.
// * Reconnect backoff 1 s → 60 s max, exponential with "equal jitter" (half fixed, half random); an idle recycle
//   reconnects immediately.
// * Close codes: 4001 DEVICE_REVOKED / 4026 UPDATE_REQUIRED → handed to the engine, and the client stays down until
//   the engine wants it again; 1012 (server restart) / 1011 (server error) → a random 5–30 s wait first, so every
//   tablet of every branch doesn't reconnect (and fetch a token + catch up) in the same second the server comes back —
//   later failures continue from a ~8 s backoff; 4400 protocol error → logged, backoff; anything else (network) → backoff.
// * 4402 SUBSCRIPTION_LOCKED → a 'locked' license signal (src/license/licenseEvents.ts) and the client stays down; the
//   engine doesn't want the socket while the stored license is locked (heartbeat polling tells when it is paid).
import type { RealtimeChanged, RealtimeHello, RealtimeServerMessage, RealtimeState, RealtimeStatus } from '@pos-api/contract';

import { deviceAuthHeaders, resetDeviceToken } from '../api/client';
import { serverConfig } from '../config/serverConfig';
import { emitLicenseSignal } from '../license/licenseEvents';

const IDLE_RECYCLE_MS = 90_000;
const HANDSHAKE_TIMEOUT_MS = 20_000; // open + state
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// After the server closes with 1012 / 1011: reconnect after a uniformly random wait in this range (thundering herd).
const SERVER_CLOSE_MIN_MS = 5_000;
const SERVER_CLOSE_MAX_MS = 30_000;
const SERVER_CLOSE_ATTEMPT = 3; // further failures back off from ~8 s, not 1 s
const STATUS_THROTTLE_MS = 1_000;

export const CLOSE_DEVICE_REVOKED = 4001;
export const CLOSE_UPDATE_REQUIRED = 4026;
export const CLOSE_SUBSCRIPTION_LOCKED = 4402;
export const CLOSE_PROTOCOL_ERROR = 4400;
export const CLOSE_SERVER_ERROR = 1011;
export const CLOSE_SERVER_RESTART = 1012;

// React Native's WebSocket takes a third `options` argument ({ headers }) — sent on the Android handshake. The DOM lib
// typing the project also sees only declares two arguments, so the RN constructor shape is spelled out here.
const RNWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string | string[] | null,
  options: { headers: Record<string, string> },
) => WebSocket;

export type RealtimeConnection ='connected' | 'reconnecting' | 'off';

export interface RealtimeHandlers {
  /** The `hello` to send right after the socket opens (app version, pending ops, cached versions). */
  hello(): Promise<RealtimeHello>;
  onState(state: RealtimeState): Promise<void>;
  onChanged(msg: RealtimeChanged): Promise<void>;
  /** 4001 / 4026 — the client has already stopped itself. */
  onRevoked(): Promise<void>;
  onUpdateRequired(minAppVersion: string | null): Promise<void>;
  /** Connection state changed. `lost` = a live link dropped for a reason other than the idle recycle. */
  onConnectionChange(conn: RealtimeConnection, lost: boolean): void;
}

let handlers: RealtimeHandlers | null = null;
let wanted = false;
let ws: WebSocket | null = null;
let live = false;
let conn: RealtimeConnection = 'off';
let attempt = 0;
let generation = 0; // bumps on every connect/teardown — stale async steps check it and bail
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastMinAppVersion: string | null = null;

// status (pending ops) reporting
let sentPending: { count: number; oldestAt: string | null } | null = null;
let wantPending: { count: number; oldestAt: string | null } | null = null;
let lastStatusAt = 0;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function log(msg: string): void {
  if (__DEV__) console.log(`[realtime] ${msg}`);
}

function setConn(next: RealtimeConnection, lost = false): void {
  if (next === conn && !lost) return;
  conn = next;
  handlers?.onConnectionChange(next, lost);
}

function clearTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
}

function detach(sock: WebSocket): void {
  sock.onopen = null;
  sock.onmessage = null;
  sock.onerror = null;
  sock.onclose = null;
  try {
    sock.close(1000);
  } catch {
    // already closed
  }
}

function backoffDelay(): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10));
  attempt++;
  return Math.round(base / 2 + Math.random() * (base / 2)); // equal jitter: [base/2, base]
}

/** The server closed us on purpose (restart / error): spread the reconnects of all tablets over 5–30 s. */
function serverCloseDelay(): number {
  attempt = Math.max(attempt, SERVER_CLOSE_ATTEMPT);
  return SERVER_CLOSE_MIN_MS + Math.floor(Math.random() * (SERVER_CLOSE_MAX_MS - SERVER_CLOSE_MIN_MS));
}

function scheduleReconnect(delayMs: number): void {
  if (!wanted) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

/** A socket went away (closed by the server, failed, or dropped by us). `delayMs` null = backoff. */
function afterDown(sock: WebSocket, delayMs: number | null, lost: boolean): void {
  if (ws !== sock) return;
  ws = null;
  const wasLive = live;
  live = false;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!wanted) {
    setConn('off', wasLive && lost);
    return;
  }
  setConn('reconnecting', wasLive && lost);
  scheduleReconnect(delayMs ?? backoffDelay());
}

function armIdle(sock: WebSocket, ms: number, onTimeout: () => void): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (ws !== sock) return;
    onTimeout();
  }, ms);
}

function armIdleRecycle(sock: WebSocket): void {
  armIdle(sock, IDLE_RECYCLE_MS, () => {
    log('idle — recycling the socket');
    detach(sock);
    afterDown(sock, 0, false);
  });
}

async function connect(): Promise<void> {
  if (!wanted || !handlers) return;
  const gen = ++generation;
  let wsUrl: string;
  let headers: Record<string, string>;
  try {
    const base = await serverConfig.getBaseUrl();
    if (!base) throw new Error('no server configured');
    const httpUrl = `${base}/pos/realtime`;
    wsUrl = httpUrl.replace(/^http/i, 'ws'); // http → ws, https → wss
    headers = await deviceAuthHeaders('GET', httpUrl);
  } catch (e) {
    if (gen !== generation || !wanted) return;
    log(`cannot prepare the handshake: ${e instanceof Error ? e.message : String(e)}`);
    setConn('reconnecting');
    scheduleReconnect(backoffDelay());
    return;
  }
  if (gen !== generation || !wanted) return;

  let sock: WebSocket;
  try {
    sock = new RNWebSocket(wsUrl, null, { headers });
  } catch (e) {
    log(`cannot open: ${e instanceof Error ? e.message : String(e)}`);
    setConn('reconnecting');
    scheduleReconnect(backoffDelay());
    return;
  }
  ws = sock;
  if (conn !== 'connected') setConn('reconnecting');
  armIdle(sock, HANDSHAKE_TIMEOUT_MS, () => {
    log('handshake timed out');
    detach(sock);
    afterDown(sock, null, false);
  });

  sock.onopen = () => {
    if (ws !== sock) return;
    const h = handlers;
    if (!h) return;
    h.hello()
      .then((hello) => {
        if (ws !== sock) return;
        sock.send(JSON.stringify(hello));
        sentPending = { count: hello.pending_ops, oldestAt: hello.oldest_pending_at };
      })
      .catch((e) => {
        if (ws !== sock) return;
        log(`hello failed: ${e instanceof Error ? e.message : String(e)}`);
        detach(sock);
        afterDown(sock, null, false);
      });
  };

  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    // Any server frame proves the link is alive.
    if (live) armIdleRecycle(sock);
    if (typeof ev.data !== 'string') return;
    let msg: RealtimeServerMessage;
    try {
      msg = JSON.parse(ev.data) as RealtimeServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      lastMinAppVersion = msg.min_app_version ?? null;
      if (!live) {
        live = true;
        attempt = 0;
        armIdleRecycle(sock);
        setConn('connected');
        flushStatus();
      }
      void handlers?.onState(msg).catch((e) => log(`state handler: ${String(e)}`));
    } else if (msg.type === 'changed') {
      void handlers?.onChanged(msg).catch((e) => log(`changed handler: ${String(e)}`));
    }
    // Unknown types are ignored (forward compatibility) — they still count as liveness.
  };

  sock.onerror = () => {
    // A 'close' always follows; handled there.
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    const code = ev.code;
    const reason = ev.reason ?? '';
    log(`closed ${code} ${reason}`);
    if (code === CLOSE_DEVICE_REVOKED) {
      wanted = false;
      afterDown(sock, null, true);
      void handlers?.onRevoked().catch(() => undefined);
      return;
    }
    if (code === CLOSE_UPDATE_REQUIRED) {
      wanted = false;
      afterDown(sock, null, true);
      void handlers?.onUpdateRequired(lastMinAppVersion).catch(() => undefined);
      return;
    }
    if (code === CLOSE_SUBSCRIPTION_LOCKED) {
      // The subscription locked: stay down (a reconnect gets 403 until it is paid); the license module records the
      // lock and the engine keeps checking in by heartbeat — it wants the socket again once a check-in says unlocked.
      wanted = false;
      afterDown(sock, null, true);
      emitLicenseSignal({ kind: 'locked', source: 'realtime' });
      return;
    }
    if (code === CLOSE_PROTOCOL_ERROR) console.warn(`[realtime] server closed with a protocol error: ${reason}`);
    // A handshake refused with 401 (RN reports "Expected HTTP 101 response but was '401 …'"): the device token may be
    // stale (server restart / secret change) — fetch a fresh one next time. A revoked device is found by the REST
    // fallback (heartbeat → 401 DEVICE_REVOKED), which runs while the socket is down.
    if (/\b401\b/.test(reason)) resetDeviceToken();
    if (code === CLOSE_SERVER_RESTART || code === CLOSE_SERVER_ERROR) {
      afterDown(sock, serverCloseDelay(), true);
      return;
    }
    afterDown(sock, null, true);
  };
}

function teardown(): void {
  generation++;
  clearTimers();
  const sock = ws;
  ws = null;
  const wasLive = live;
  live = false;
  if (sock) detach(sock);
  sentPending = null;
  setConn('off', wasLive);
}

function sendStatus(): void {
  if (!ws || !live || !wantPending) return;
  if (sentPending && sentPending.count === wantPending.count && sentPending.oldestAt === wantPending.oldestAt) return;
  const msg: RealtimeStatus = { type: 'status', pending_ops: wantPending.count, oldest_pending_at: wantPending.oldestAt };
  try {
    ws.send(JSON.stringify(msg));
    sentPending = { ...wantPending };
    lastStatusAt = Date.now();
  } catch {
    // The close handler reconnects; the next hello carries the count.
  }
}

function flushStatus(): void {
  if (statusTimer) return;
  const wait = Math.max(0, lastStatusAt + STATUS_THROTTLE_MS - Date.now());
  if (wait === 0) {
    sendStatus();
    return;
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    sendStatus();
  }, wait);
}

export const realtime = {
  configure(h: RealtimeHandlers): void {
    handlers = h;
  },

  /** Connect (and keep reconnecting) while wanted; close at once when not. Idempotent. */
  setWanted(want: boolean): void {
    if (want === wanted) return;
    wanted = want;
    if (want) {
      attempt = 0;
      setConn('reconnecting');
      void connect();
    } else {
      teardown();
    }
  },

  /** The outbox's pending count; sent as a `status` frame when it changed (throttled to one per second). */
  reportPending(count: number, oldestAt: string | null): void {
    wantPending = { count, oldestAt };
    if (live) flushStatus();
  },

  isLive(): boolean {
    return live;
  },

  connection(): RealtimeConnection {
    return conn;
  },
};
