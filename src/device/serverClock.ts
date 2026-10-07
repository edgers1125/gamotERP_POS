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
// * Everything else (sale / void / drawer times) stays on the DEVICE clock on purpose — the server flags those with
//   CLOCK_DRIFT rather than having them silently corrected.
import * as SecureStore from 'expo-secure-store';

const KEY = 'gamoterp_pos.server_clock_offset_ms';
const UPDATE_THRESHOLD_MS = 5_000;
const MAX_ABS_OFFSET_MS = 20 * 365 * 24 * 3600_000; // anything beyond this is a garbage value, not a clock

let offsetMs = 0;
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        const n = raw === null ? NaN : Number(raw);
        if (Number.isFinite(n) && Math.abs(n) <= MAX_ABS_OFFSET_MS) offsetMs = n;
      } catch {
        // unreadable → 0 (the device clock); learned again from the next response
      }
    })();
  }
  return loaded;
}

/** Applies a new estimate; returns true when the offset changed by more than the threshold (and was persisted). */
function apply(estimate: number): boolean {
  if (!Number.isFinite(estimate) || Math.abs(estimate) > MAX_ABS_OFFSET_MS) return false;
  if (Math.abs(estimate - offsetMs) <= UPDATE_THRESHOLD_MS) return false;
  offsetMs = Math.round(estimate);
  SecureStore.setItemAsync(KEY, String(offsetMs)).catch(() => undefined);
  return true;
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

  /** The current offset (server − device, ms) — for diagnostics. */
  async offsetMs(): Promise<number> {
    await load();
    return offsetMs;
  },

  /** Learns from a response: `serverTime` (body `server_time`, preferred) or the `Date` header. `localAt` = device
   * time (ms) when the response headers arrived. Returns true when the offset changed (a refused proof is then worth
   * one retry). */
  async observe(serverTime: unknown, dateHeader: string | null, localAt: number): Promise<boolean> {
    await load();
    const precise = serverTimeMs(serverTime);
    if (precise !== null) return apply(precise - localAt);
    if (dateHeader) {
      const t = Date.parse(dateHeader);
      if (Number.isFinite(t)) return apply(t + 500 - localAt);
    }
    return false;
  },
};
