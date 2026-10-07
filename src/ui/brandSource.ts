// Decides WHICH brand the app is themed with and feeds it to useBrandTheme (src/ui/brandTheme.ts). Same rule as the
// web app (GamotERP frontend CompanyBrandingContext / backend lib/pos-cashier-brand.ts):
//
//   * A cashier signed in (online or offline PIN) → that cashier's brand in the terminal's company: the brand on their
//     membership, else the company's default brand, else standard. It arrives with the online sign-in (POST
//     /pos/session `brand`, cached by cashierSession) and is re-checked with GET /pos/cashier/brand whenever a cashier
//     is signed in ONLINE and something may have changed: sign-in, a sync cycle that reached the server (incl. manual
//     "Sync now"), the app coming back to the foreground, or `brandSource.refresh()` (for a realtime `display` notice).
//     Until a cashier's brand is known at all, the terminal's brand stands in.
//   * No cashier (locked / login screen) → the terminal's display brand, read from the customer display's cached
//     config (displayService, modules/pos-display: filesDir/customer_display/config.json + its logo file). Nothing cached
//     (first start, Expo Go, no display module) → standard.
//
// OFFLINE: every cashier's brand is cached in the encrypted local DB keyed by user id (localStore.saveCashierBrand), and
// each logo once per sha256 checksum (localStore.saveBrandLogo) — downloaded only when the checksum is new, pruned when
// no cached cashier uses it. An offline PIN unlock therefore restores the right colours, name and logo with no network.
// Logos are kept in the DB (shown as a data: URI), NOT in the display module's image dir: displayService prunes every
// file there that its own config doesn't use, which would silently delete cashier logos.
import { AppState, type AppStateStatus } from 'react-native';
import type { PosBrand } from '@pos-api/contract';

import PosDisplay from '../../modules/pos-display';
import { api } from '../api/client';
import { cashierSession, useCashier } from '../auth/cashierSession';
import type { CashierState } from '../contracts';
import { onLocalStoreEvent } from '../db/events';
import { localStore } from '../db/localStore';
import { onRealtimeNotice, useSyncStatus } from '../sync/syncEngine';
import { useBrandTheme, type AppliedBrand } from './brandTheme';

const STANDARD: AppliedBrand = { source: 'standard', name: null, primary: null, secondary: null, logoUri: null };
/** Minimum gap between two automatic GET /pos/cashier/brand calls (sync cycles can be seconds apart). */
const REFRESH_THROTTLE_MS = 15_000;
/** Cache-only re-read (no network) — picks up a display-config refresh that finished after the last trigger. */
const REAPPLY_INTERVAL_MS = 60_000;
const TERMINAL_REREAD_DEBOUNCE_MS = 2_000;

let started = false;
let generation = 0; // bumped on every cashier change: a late result for an earlier cashier is dropped
let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;
let cleanups: (() => void)[] = [];

const isNotFound = (e: unknown) => !!e && typeof e === 'object' && (e as { status?: unknown }).status === 404;
const hexOrNull = (v: unknown): string | null => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// ---- the terminal's brand (customer display cache) --------------------------------------------------------------------

async function terminalBrand(): Promise<AppliedBrand> {
  if (!PosDisplay) return STANDARD;
  try {
    const raw = await PosDisplay.readConfigCache();
    if (!raw) return STANDARD;
    const c = JSON.parse(raw) as { brand?: { name?: unknown; primaryColor?: unknown; secondaryColor?: unknown }; logoFile?: unknown };
    if (!c || !c.brand) return STANDARD;
    let logoUri: string | null = null;
    if (typeof c.logoFile === 'string' && c.logoFile) {
      const path = await PosDisplay.imagePath(c.logoFile);
      if (path) logoUri = path.startsWith('file:') ? path : `file://${path}`;
    }
    return {
      source: 'terminal',
      name: textOrNull(c.brand.name),
      primary: hexOrNull(c.brand.primaryColor),
      secondary: hexOrNull(c.brand.secondaryColor),
      logoUri,
    };
  } catch {
    return STANDARD;
  }
}

// ---- a cashier's brand (local cache) ------------------------------------------------------------------------------------

async function cachedCashierBrand(userId: number): Promise<AppliedBrand | null> {
  const b = await localStore.getCashierBrand(userId).catch(() => null);
  if (!b) return null;
  let logoUri: string | null = null;
  if (b.has_logo && b.logo_checksum) {
    const img = await localStore.getBrandLogo(b.logo_checksum).catch(() => null);
    if (img) logoUri = `data:${img.content_type || 'image/png'};base64,${img.data_base64}`;
  }
  return { source: 'cashier', name: textOrNull(b.name), primary: hexOrNull(b.primary_color), secondary: hexOrNull(b.secondary_color), logoUri };
}

/** Stores a cashier's brand (and its logo when the checksum is new and a download is possible). Never throws. */
async function storeCashierBrand(userId: number, brand: PosBrand, canDownload: boolean): Promise<void> {
  try {
    if (brand.has_logo && brand.logo_checksum && canDownload && !(await localStore.getBrandLogo(brand.logo_checksum))) {
      try {
        const img = await api.cashierBrandLogo();
        if (img && typeof img.data_base64 === 'string' && img.data_base64 !== '') await localStore.saveBrandLogo(brand.logo_checksum, img);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    await localStore.saveCashierBrand(userId, brand);
  } catch {
    // Offline / server error: keep what's cached; the next trigger tries again.
  }
}

// ---- apply ---------------------------------------------------------------------------------------------------------------

async function applyCurrent(): Promise<void> {
  const gen = generation;
  const cashier = useCashier.getState().cashier;
  const brand = (cashier ? await cachedCashierBrand(cashier.userId) : null) ?? (await terminalBrand());
  if (gen !== generation || !started) return;
  useBrandTheme.getState().apply(brand);
}

async function doRefresh(): Promise<void> {
  const cashier = useCashier.getState().cashier;
  if (!cashier || !cashierSession.isOnlineSession()) return;
  const gen = generation;
  lastRefreshAt = Date.now();
  let brand: PosBrand;
  try {
    brand = await api.cashierBrand();
  } catch {
    return; // offline / older server without the route: the cache stays
  }
  if (!brand || typeof brand !== 'object' || gen !== generation) return;
  await storeCashierBrand(cashier.userId, brand, true);
  if (gen === generation) await applyCurrent();
}

/** Re-checks the signed-in (online) cashier's brand with the server. One at a time; never throws. */
function refreshCashierBrand(force: boolean): Promise<void> {
  if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return refreshing ?? Promise.resolve();
  if (!refreshing) {
    refreshing = doRefresh()
      .catch(() => undefined)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function onCashierChange(next: CashierState | null, prev: CashierState | null): void {
  if (next?.userId === prev?.userId && next?.mode === prev?.mode && next?.token === prev?.token) return;
  generation++;
  void applyCurrent();
  if (next && cashierSession.isOnlineSession()) void refreshCashierBrand(true);
}

export const brandSource = {
  /** Starts following the cashier / terminal brand (App.tsx Shell, once the local DB is open). Idempotent. */
  start(): void {
    if (started) return;
    started = true;
    generation++;
    void applyCurrent();
    if (cashierSession.isOnlineSession()) void refreshCashierBrand(true);

    cleanups.push(useCashier.subscribe((s, prev) => onCashierChange(s.cashier, prev.cashier)));
    // Server push: the terminal's display brand ('display') or a brand edit / cashier brand reassignment ('terminal').
    // Re-read after a short delay so the display config refresh the same notice triggers has landed.
    cleanups.push(
      onRealtimeNotice((kind) => {
        if (kind !== 'display' && kind !== 'terminal') return;
        setTimeout(() => void brandSource.refresh(), 1_500);
      }),
    );
    // A sync cycle that reached the server (incl. "Sync now"): re-check the cashier's brand; no cashier → re-read the
    // terminal's (the display config may have just been refreshed).
    cleanups.push(
      useSyncStatus.subscribe((s, prev) => {
        if (s.lastSyncAt === prev.lastSyncAt) return;
        if (useCashier.getState().cashier) void refreshCashierBrand(false);
        else void applyCurrent();
      }),
    );
    // Bootstrap refreshes (which also refresh the display config) emit 'changed'; re-read shortly after, cache only.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    cleanups.push(
      onLocalStoreEvent((ev) => {
        if (ev !== 'changed' || useCashier.getState().cashier) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          void applyCurrent();
        }, TERMINAL_REREAD_DEBOUNCE_MS);
      }),
    );
    cleanups.push(() => {
      if (debounce) clearTimeout(debounce);
    });
    const appSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') return;
      void applyCurrent();
      void refreshCashierBrand(false);
    });
    cleanups.push(() => appSub.remove());
    const interval = setInterval(() => void applyCurrent(), REAPPLY_INTERVAL_MS);
    cleanups.push(() => clearInterval(interval));
  },

  /** Stops following and returns to the standard look (e.g. the device left enrollment). */
  stop(): void {
    if (!started) return;
    started = false;
    generation++;
    for (const c of cleanups) c();
    cleanups = [];
    useBrandTheme.getState().apply(STANDARD);
  },

  /**
   * Something brand-related may have changed on the server (a realtime `display` notice): re-read the terminal's
   * brand from the display cache and re-check the online cashier's brand. Never throws.
   */
  async refresh(): Promise<void> {
    if (!started) return;
    await applyCurrent();
    await refreshCashierBrand(true);
  },
};
