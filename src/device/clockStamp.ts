// The time and the clock report stamped on a sale / void (and the drawer's times) when it is MADE (contract
// `PosClockReport`). The stamp goes into the signed payload, so an op synced hours later still carries the values from
// creation, not from sync time.
//   at = the corrected time from the monotonic anchor (src/device/serverClock.ts `corrected()`); with no anchor (after a
//   reboot, before the next server contact) the raw device time and `server_offset_ms: null`.
//   clock = omitted when the native build cannot report Automatic date & time (old build — selling is not blocked, but
//   we do not claim `auto_time: true`).
import type { PosClockReport } from '@pos-api/contract';

import { autoTime } from './autoTime';
import { serverClock } from './serverClock';

export interface ClockStamp {
  at: Date;
  clock?: PosClockReport;
}

export async function stampClock(): Promise<ClockStamp> {
  const [auto, t] = await Promise.all([autoTime.read(), serverClock.corrected()]);
  return {
    at: new Date(t.nowMs),
    clock: auto.known ? { auto_time: auto.autoTime, server_offset_ms: t.offsetMs, offset_measured_at: t.measuredAt } : undefined,
  };
}
