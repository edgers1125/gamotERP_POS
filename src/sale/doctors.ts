// The doctors list of the Rx step (GET /pos/prescription-doctors — every ACTIVE doctor of the company, ≤ 5,000), cached
// for offline in the meta table (localStore getDoctors / saveDoctors) and mirrored in `useDoctors` for the screens.
// Kept fresh like the approver lists (src/sync/syncEngine.ts): the realtime `hello` sends `versions.doctors` (null until
// first fetched — that opts this device in), `state` / `changed` kind 'doctors' carry the server's version, and a
// differing one is fetched. The route needs an ONLINE cashier: without one the refresh waits (`pendingVersion`) and the
// sync cycle retries it. Adding a doctor and filling in missing details are online only; the result is put in the cache
// at once and the whole list re-fetched (its version changed).
import { create } from 'zustand';
import type { PosCreatePrescriptionDoctorRequest, PosFillPrescriptionDoctorResponse, PosPrescriptionDoctor } from '@pos-api/contract';
import { api } from '../api/client';
import { cashierSession } from '../auth/cashierSession';
import type { PosFillPrescriptionDoctorRequest } from '../contracts';
import { localStore } from '../db/localStore';

export interface DoctorsState {
  items: PosPrescriptionDoctor[];
  /** The cached list's version (null = never fetched). */
  version: string | null;
  /** The server left doctors out (> 5,000) — the rest are only on the web. */
  truncated: boolean;
  /** When the cached list was saved (ISO; null = never). */
  savedAt: string | null;
  /** The cache has been read from the DB. */
  loaded: boolean;
  refreshing: boolean;
}

export const useDoctors = create<DoctorsState>()(() => ({ items: [], version: null, truncated: false, savedAt: null, loaded: false, refreshing: false }));

let loadJob: Promise<void> | null = null;
let refreshJob: Promise<boolean> | null = null;
let pendingVersion: string | null = null; // a newer server version not fetched yet (no online cashier)
let triedAt = 0;
const RETRY_MS = 60_000;

function byName(a: PosPrescriptionDoctor, b: PosPrescriptionDoctor): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

async function load(): Promise<void> {
  if (useDoctors.getState().loaded) return;
  loadJob ??= (async () => {
    const cached = await localStore.getDoctors().catch(() => null);
    useDoctors.setState({
      items: cached?.items ?? [],
      version: cached?.version ?? null,
      truncated: cached?.truncated ?? false,
      savedAt: cached?.saved_at ?? null,
      loaded: true,
    });
  })().finally(() => {
    loadJob = null;
  });
  return loadJob;
}

/** Fetches the whole list (needs an online cashier). Returns true when the cache was replaced. Never throws. */
async function refresh(): Promise<boolean> {
  if (!cashierSession.isOnlineSession()) return false;
  refreshJob ??= (async () => {
    const target = pendingVersion;
    triedAt = Date.now();
    useDoctors.setState({ refreshing: true });
    try {
      const list = await api.prescriptionDoctors();
      await localStore.saveDoctors(list);
      useDoctors.setState({ items: list.items, version: list.version, truncated: list.truncated, savedAt: new Date().toISOString(), loaded: true });
      if (pendingVersion === target) pendingVersion = null;
      return true;
    } catch {
      return false; // keep the cache; retried by the cycle / next notice / next Rx step
    } finally {
      useDoctors.setState({ refreshing: false });
    }
  })().finally(() => {
    refreshJob = null;
  });
  return refreshJob;
}

/** Puts one doctor (added / filled in online) into the cache now; the list's version is left as is so the next check
 * re-fetches the whole list. */
async function upsert(doctor: PosPrescriptionDoctor): Promise<void> {
  await load();
  const s = useDoctors.getState();
  const items = [...s.items.filter((d) => d.id !== doctor.id), doctor].sort(byName);
  useDoctors.setState({ items });
  await localStore.saveDoctors({ version: s.version ?? '', truncated: s.truncated, items }).catch(() => undefined);
}

export const doctorsCache = {
  load,
  refresh,

  /** The cached version for the realtime hello (null = none yet — still opts in). */
  async cachedVersion(): Promise<string | null> {
    await load();
    return useDoctors.getState().version || null;
  },

  /** A server version (realtime state / changed). `undefined` = the server doesn't send doctors (older) → nothing. */
  async refreshIfDifferent(serverVersion: string | null | undefined): Promise<void> {
    if (serverVersion === undefined || serverVersion === null) return;
    await load();
    if (useDoctors.getState().version === serverVersion) {
      pendingVersion = null;
      return;
    }
    pendingVersion = serverVersion;
    await refresh();
  },

  /** A deferred refresh is due (the sync cycle calls `refresh` then). */
  retryDue(now = Date.now()): boolean {
    return pendingVersion !== null && now - triedAt >= RETRY_MS;
  },

  /** "Doctor not in the list — add" (online). Throws ApiError (409 PRESCRIPTION_DOCTOR_LICENSE_TAKEN: `details.doctor`). */
  async add(body: PosCreatePrescriptionDoctorRequest): Promise<PosPrescriptionDoctor> {
    const doctor = await api.createPrescriptionDoctor(body);
    await upsert(doctor);
    void refresh();
    return doctor;
  },

  /** "Fill in missing details" (online) — only empty fields are set. Throws ApiError. */
  async fillMissing(id: number, body: PosFillPrescriptionDoctorRequest): Promise<PosFillPrescriptionDoctorResponse> {
    const res = await api.fillPrescriptionDoctor(id, body);
    await upsert(res.doctor);
    void refresh();
    return res;
  },
};

/** The 409 PRESCRIPTION_DOCTOR_LICENSE_TAKEN details → the doctor that already has the PRC (null = not that error). */
export function licenseTakenDoctor(e: unknown): { id: number; name: string; is_active: boolean } | null {
  const x = e as { code?: unknown; details?: { doctor?: { id?: unknown; name?: unknown; is_active?: unknown } } | null } | null;
  if (!x || x.code !== 'PRESCRIPTION_DOCTOR_LICENSE_TAKEN') return null;
  const d = x.details?.doctor;
  if (!d || typeof d.id !== 'number' || typeof d.name !== 'string') return null;
  return { id: d.id, name: d.name, is_active: d.is_active === true };
}
