// The server's clock as seen from this tablet — used ONLY for the DPoP proof's `iat` (src/device/jose.ts), which the
// server accepts within ±DPOP_ACCEPTED_SKEW_SECONDS (5 min, pos-api/contract.ts) of ITS time. A tablet whose own clock is minutes off (no network
// time, dead RTC battery, a cashier "fixing" the time) could otherwise never get a device token or sync.
//
// * offset = server time − device time (ms), learned from every backend response (api/client.ts `send`): the body's
//   `server_time` when it has one (ISO-8601, ms precision — success bodies and the 401 a DPoP/clock refusal returns),
//   else the HTTP `Date` header (1 s precision; +500 ms for the truncation, measured when the headers arrived).
// * Only a change bigger than UPDATE_THRESHOLD_MS is applied (Date-header jitter is ±1 s; the proof window is ±5 min), so
//   it is persisted (expo-secure-store) only when the clock really moved. A wrong persisted offset heals itself: the
//   next refused proof brings the server's time and the request is retried once (api/client.ts).
// * Also records WHEN the offset was last confirmed (server time, `measuredAtMs`) on EVERY successful observation, even
//   when the offset itself did not move — a sale / void reports it (src/device/clockStamp.ts → PosClockReport
//   `offset_measured_at`; the server calls an offset older than 24 h stale). Persisted at most once a minute.
// * Sale / void / drawer times (clockStamp.ts -> `corrected()`) are NOT wall clock + offset: that could be defeated
//   offline (auto time off -> clock set back -> auto time on keeps the manual time without a network, offset still
//   "fresh"). They come from a MONOTONIC ANCHOR: on every server contact we store (server time,
//   SystemClock.elapsedRealtime(), boot id = Settings.Global.BOOT_COUNT) -- modules/pos-device `getClockAnchor`.
//   corrected now = anchor server time + (elapsed now - anchor elapsed), valid only while the boot id matches. No anchor
//   (never contacted since boot / reboot) -> the raw device time is stamped with `server_offset_ms: null` (the server
//   then uses its window checks). Reported `server_offset_ms` = corrected - wall, so a changed wall clock shows up. A
//   build without `getClockAnchor` (old native) falls back to wall + offset. The DPoP `iat` (nowMs) keeps using
//   wall + offset: it self-heals on a refusal. Attendance times stay on the device clock (server flags CLOCK_DRIFT).
import * as SecureStore from 'expo-secure-store';

import NativePosDevice from '../../modules/pos-device';
import { isExpoGo } from '../config/runtime';

const KEY = 'gamoterp_pos.server_clock_offset_ms';
const MEASURED_KEY = 'gamoterp_pos.server_clock_measured_at_ms';
const ANCHOR_KEY = 'gamoterp_pos.server_clock_anchor';
const MEASURED_WRITE_EVERY_MS = 60_000;
const UPDATE_THRESHOLD_MS = 5_000;
const MAX_ABS_OFFSET_MS = 20 * 365 * 24 * 3600_000; // anything beyond this is a garbage value, not a clock

let offsetMs = 0;
let known = false; // an offset was ever measured (or restored from storage)
let measuredAtMs: number | null = null; // server time (epoch ms) when the offset was last confirmed
let measuredPersistedAt = 0; // device time of the last write of MEASURED_KEY
let loaded: Promise<void> | null = null;

interface Anchor {
  serverMs: number; // server time (epoch ms) at the moment of contact
  elapsedMs: number; // SystemClock.elapsedRealtime() at that moment
  bootId: string; // reboot identity at that moment
}
let anchor: Anchor | null = null;
let anchorPersistedAt = 0; // device time of the last write of ANCHOR_KEY

/** The native build can give a monotonic reading (Expo Go preview: the wall clock stands in). */
function anchorSupported(): boolean {
  if (isExpoGo) return true;
  return !!NativePosDevice && typeof NativePosDevice.getClockAnchor === 'function';
}

/** Monotonic ms-since-boot + boot id; null when it cannot be read or the boot id is unknown. */
async function readMonotonic(): Promise<{ elapsedMs: number; bootId: string } | null> {
  try {
    if (isExpoGo) return { elapsedMs: Date.now(), bootId: 'expo-go' };
    if (!NativePosDevice || typeof NativePosDevice.getClockAnchor !== 'function') return null;
    const r = await NativePosDevice.getClockAnchor();
    if (!r || !Number.isFinite(r.elapsedRealtimeMs) || r.elapsedRealtimeMs < 0 || !r.bootId) return null;
    return { elapsedMs: r.elapsedRealtimeMs, bootId: r.bootId };
  } catch {
    return null;
  }
}

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        const n = raw === null ? NaN : Number(raw);
        if (Number.isFinite(n) && Math.abs(n) <= MAX_ABS_OFFSET_MS) {
          offsetMs = n;
          known = true;
        }
        const rawAt = await SecureStore.getItemAsync(MEASURED_KEY);
        const at = rawAt === null ? NaN : Number(rawAt);
        if (Number.isFinite(at) && at > 0) measuredAtMs = at;
        const rawAnchor = await SecureStore.getItemAsync(ANCHOR_KEY);
        if (rawAnchor) {
          const a = JSON.parse(rawAnchor) as Partial<Anchor>;
          if (
            typeof a.serverMs === 'number' && Number.isFinite(a.serverMs) && a.serverMs > 0 &&
            typeof a.elapsedMs === 'number' && Number.isFinite(a.elapsedMs) && a.elapsedMs >= 0 &&
            typeof a.bootId === 'string' && a.bootId
          ) {
            anchor = { serverMs: a.serverMs, elapsedMs: a.elapsedMs, bootId: a.bootId };
          }
        }
      } catch {
        // unreadable → 0 (the device clock); learned again from the next response
      }
    })();
  }
  return loaded;
}

/** Applies a new estimate; returns true when the offset changed by more than the threshold (and was persisted). */
function apply(estimate: number, localAt: number): boolean {
  if (!Number.isFinite(estimate) || Math.abs(estimate) > MAX_ABS_OFFSET_MS) return false;
  const moved = Math.abs(estimate - offsetMs) > UPDATE_THRESHOLD_MS;
  if (moved || !known) {
    offsetMs = Math.round(estimate);
    SecureStore.setItemAsync(KEY, String(offsetMs)).catch(() => undefined);
  }
  known = true;
  // Confirmed now: server time = device time at the response + the offset in force.
  measuredAtMs = localAt + offsetMs;
  if (moved || localAt - measuredPersistedAt >= MEASURED_WRITE_EVERY_MS) {
    measuredPersistedAt = localAt;
    SecureStore.setItemAsync(MEASURED_KEY, String(measuredAtMs)).catch(() => undefined);
  }
  return moved;
}

/** Records the (server time, monotonic) pair for a server contact whose offset estimate (server - device) is `estimate`. */
async function recordAnchor(estimate: number): Promise<void> {
  if (!Number.isFinite(estimate) || Math.abs(estimate) > MAX_ABS_OFFSET_MS) return;
  const cur = await readMonotonic();
  if (!cur) return;
  const wall = Date.now();
  anchor = { serverMs: Math.round(wall + estimate), elapsedMs: cur.elapsedMs, bootId: cur.bootId };
  if (wall - anchorPersistedAt >= MEASURED_WRITE_EVERY_MS) {
    anchorPersistedAt = wall;
    SecureStore.setItemAsync(ANCHOR_KEY, JSON.stringify(anchor)).catch(() => undefined);
  }
}

/** A `server_time` value → epoch ms: an ISO-8601 string, or a number (epoch seconds or ms). null if unusable. */
function serverTimeMs(value: unknown): number | null {
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  return null;
}

export const serverClock = {
  /** The server's current time (epoch ms) as best known. */
  async nowMs(): Promise<number> {
    await load();
    return Date.now() + offsetMs;
  },

  /** The offset nowMs() adds (server − device, ms) for a render that can't await — the clock attendance punches are
   * stamped with. Loaded by the first backend call (0 before that). The punch ORDER buttons use it (punch.ts
   * punchRuleNow), so a tablet with a wrong date judges the 16 h rule on the server's time. */
  offsetMsSync(): number {
    return offsetMs;
  },

  /** The current offset (server − device, ms) — for diagnostics. */
  async offsetMs(): Promise<number> {
    await load();
    return offsetMs;
  },

  /** The corrected "now" for a sale / void / drawer time and what the PosClockReport carries: `nowMs` (epoch ms),
   * `offsetMs` = nowMs - device wall clock (null = no trustworthy anchor, nowMs is then the raw device time),
   * `measuredAt` = ISO server time of the anchor (null = unknown). See the header: monotonic anchor, null after reboot. */
  async corrected(): Promise<{ nowMs: number; offsetMs: number | null; measuredAt: string | null }> {
    await load();
    if (!anchorSupported()) {
      // Old native build: wall clock + learned offset (the pre-anchor behaviour).
      const wall = Date.now();
      return {
        nowMs: wall + (known ? offsetMs : 0),
        offsetMs: known ? offsetMs : null,
        measuredAt: known && measuredAtMs !== null ? new Date(measuredAtMs).toISOString() : null,
      };
    }
    const cur = await readMonotonic();
    const wall = Date.now();
    const a = anchor;
    if (!cur || !a || cur.bootId !== a.bootId || cur.elapsedMs < a.elapsedMs) {
      return { nowMs: wall, offsetMs: null, measuredAt: null };
    }
    const nowMs = a.serverMs + (cur.elapsedMs - a.elapsedMs);
    return { nowMs, offsetMs: Math.round(nowMs - wall), measuredAt: new Date(a.serverMs).toISOString() };
  },

  /** Learns from a response: `serverTime` (body `server_time`, preferred) or the `Date` header. `localAt` = device
   * time (ms) when the response headers arrived. Returns true when the offset changed (a refused proof is then worth
   * one retry). */
  async observe(serverTime: unknown, dateHeader: string | null, localAt: number): Promise<boolean> {
    await load();
    const precise = serverTimeMs(serverTime);
    if (precise !== null) {
      await recordAnchor(precise - localAt);
      return apply(precise - localAt, localAt);
    }
    if (dateHeader) {
      const t = Date.parse(dateHeader);
      if (Number.isFinite(t)) {
        await recordAnchor(t + 500 - localAt);
        return apply(t + 500 - localAt, localAt);
      }
    }
    return false;
  },
};
