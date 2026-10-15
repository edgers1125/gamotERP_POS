// Android "Automatic date & time" (Settings.Global.AUTO_TIME), read through the local `PosDevice` Expo module
// (modules/pos-device: getAutoTime / openDateSettings). With it OFF anyone can set the tablet's clock to anything, and
// the server uses a sale's / void's device time to decide stock effects around stock counts — so selling and voiding are
// refused while it is off (src/db/policy.ts `AUTO_TIME_OFF_MESSAGE`, localStore.recordSale / recordVoid).
//
// Fails CLOSED: a setting that cannot be read counts as off. Exceptions: Expo Go preview (no native module — the
// software module reports on) and a build whose native module predates this function: selling is NOT blocked (an old
// dev client keeps working until rebuilt) but the state is UNKNOWN (`known: false`) and a sale / void then omits the
// `clock` report instead of claiming auto time is on (src/device/clockStamp.ts).
import NativePosDevice from '../../modules/pos-device';
import { isExpoGo } from '../config/runtime';

export interface AutoTimeState {
  autoTime: boolean;
  autoTimeZone: boolean;
  /** false = the native build cannot report it (old build): `autoTime` is then a placeholder `true`. */
  known: boolean;
}

export const autoTime = {
  /** The current switches, read fresh from Android every call (cheap) — never cached, the cashier can flip it any time. */
  async read(): Promise<AutoTimeState> {
    if (isExpoGo || !NativePosDevice) return { autoTime: true, autoTimeZone: true, known: true };
    if (typeof NativePosDevice.getAutoTime !== 'function') return { autoTime: true, autoTimeZone: true, known: false };
    try {
      return { ...(await NativePosDevice.getAutoTime()), known: true };
    } catch {
      return { autoTime: false, autoTimeZone: false, known: true };
    }
  },

  /** Automatic date & time is ON (the only thing that gates selling; the time-zone switch is reported, not enforced). */
  async isOn(): Promise<boolean> {
    return (await autoTime.read()).autoTime;
  },

  /** Opens Android's Date & time settings; false when it could not be opened. */
  async openSettings(): Promise<boolean> {
    if (isExpoGo || !NativePosDevice || typeof NativePosDevice.openDateSettings !== 'function') return false;
    try {
      return await NativePosDevice.openDateSettings();
    } catch {
      return false;
    }
  },
};
