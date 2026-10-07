// The customer display's brand + ads, offline-first (contract "Customer display": GET /pos/display, /logo, /ads/:id —
// device auth only). The last good config and its images are cached as files by the native module
// (modules/pos-display: filesDir/customer_display/), so the second monitor works fully offline from cache.
//
//   * loadCached() — at startup (and on hot-plug): push the cached config to the display (no network).
//   * refresh()    — called by the sync engine after each bootstrap/catalog refresh (startup, after enrollment, every
//                    ~15 min) and on a real-time `display` notice: GET /pos/display; same `version` and every file
//                    still there → nothing to download. Otherwise each image is fetched only if no file with its
//                    checksum exists yet (files are named by checksum, so a new logo = a new file name), then the new
//                    config is cached, pushed, and files no longer used are pruned.
// A failed refresh (offline, endpoint not deployed yet, …) keeps the previous cache and display. Never throws.
//
// cachedDisplayBrand() / onDisplayBrandChange() expose the cached brand (name, colours, logo file URI) to the rest of
// the app, e.g. to theme it when no cashier is signed in.
import type { PosDisplayConfig } from '@pos-api/contract';

import PosDisplay from '../../modules/pos-display';
import type { PosDisplayNativeConfig } from '../../modules/pos-display';
import { api } from '../api/client';
import { colors } from '../ui/theme';

interface CachedDisplay {
  version: string;
  brand: { name: string; primaryColor: string; secondaryColor: string };
  /** Cached file names (not paths), resolved through the module when pushed. */
  logoFile: string | null;
  ads: { id: number; file: string; durationSeconds: number }[];
}

/** The brand the display shows from cache. */
export interface DisplayBrand {
  name: string;
  primaryColor: string; // #rrggbb
  secondaryColor: string; // #rrggbb
  /** `file://` URI of the cached logo, or null (no logo, or its file is missing). */
  logoUri: string | null;
}

let inFlight: Promise<void> | null = null;

// The newest config known to this process — read from disk once (ensureLoaded) and replaced by every refresh. Pushes
// always send THIS, not whatever a caller read earlier, so a slow startup / hot-plug push of an older cache can never
// overwrite a newer config a refresh pushed meanwhile (whose predecessor's logo file may already be pruned).
let latest: CachedDisplay | null = null;
let loading: Promise<void> | null = null;
let pushGeneration = 0;
let brand: DisplayBrand | null = null;
const brandListeners = new Set<(b: DisplayBrand | null) => void>();

function safe(checksum: string): string {
  return checksum.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'x';
}

const logoFileName = (checksum: string) => `logo-${safe(checksum)}`;
const adFileName = (id: number, checksum: string) => `ad-${id}-${safe(checksum)}`;

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { status?: unknown }).status === 404;
}

function parseCache(json: string | null): CachedDisplay | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as CachedDisplay;
    return c && typeof c.version === 'string' && c.brand && Array.isArray(c.ads) ? c : null;
  } catch {
    return null;
  }
}

async function readCache(): Promise<CachedDisplay | null> {
  if (!PosDisplay) return null;
  return parseCache(await PosDisplay.readConfigCache());
}

/** Reads the disk cache into `latest` once — never over a newer config a refresh already adopted. */
function ensureLoaded(): Promise<void> {
  if (latest || !PosDisplay) return Promise.resolve();
  if (!loading) {
    loading = readCache()
      .then((c) => {
        if (c && !latest) latest = c;
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function setBrand(next: DisplayBrand | null): void {
  const same =
    next === brand ||
    (!!next &&
      !!brand &&
      next.name === brand.name &&
      next.primaryColor === brand.primaryColor &&
      next.secondaryColor === brand.secondaryColor &&
      next.logoUri === brand.logoUri);
  if (same) return;
  brand = next;
  for (const cb of brandListeners) {
    try {
      cb(next);
    } catch {
      // A listener's failure never breaks the display.
    }
  }
}

/** MedSource's deep blue — the customer display's backdrop for the standard brand (flat colour, no gradients). */
const MEDSOURCE_DISPLAY_BLUE = '#033f74';

const sameHex = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Backdrop + accent of the customer display. The server sends the standard colours (theme.ts primary / secondary)
 * when a brand sets none, so a standard primary means "MedSource": deep blue with the MedSource green accent. A brand
 * with its own colours keeps its identity — its primary as the backdrop, its own secondary (if any) as the accent.
 * The native side guarantees contrast (darkens a pale backdrop, lightens a dim accent).
 */
function displayColors(primary: string, secondary: string): { displayBackground: string; accent: string } {
  return {
    displayBackground: sameHex(primary, colors.primary) ? MEDSOURCE_DISPLAY_BLUE : primary,
    accent: sameHex(secondary, colors.secondary) ? colors.accent : secondary,
  };
}

/** Pushes `latest` to the native display (paths resolved; missing files are left out). The newest call wins. */
async function pushLatest(): Promise<void> {
  if (!PosDisplay) return;
  const gen = ++pushGeneration;
  const cache = latest;
  if (!cache) return;
  const logoPath = cache.logoFile ? await PosDisplay.imagePath(cache.logoFile) : null;
  const ads: PosDisplayNativeConfig['ads'] = [];
  for (const ad of cache.ads) {
    const path = await PosDisplay.imagePath(ad.file);
    if (path) ads.push({ path, durationSeconds: ad.durationSeconds });
  }
  if (gen !== pushGeneration) return; // a newer push is on its way
  const config: PosDisplayNativeConfig = {
    brandName: cache.brand.name,
    primaryColor: cache.brand.primaryColor,
    secondaryColor: cache.brand.secondaryColor,
    logoPath,
    ads,
    palette: {
      ...displayColors(cache.brand.primaryColor, cache.brand.secondaryColor),
      onPrimary: colors.onPrimary,
      background: colors.background,
      text: colors.text,
      muted: colors.muted,
      success: colors.success,
      border: colors.border,
    },
  };
  PosDisplay.setConfig(JSON.stringify(config));
  setBrand({
    name: cache.brand.name,
    primaryColor: cache.brand.primaryColor,
    secondaryColor: cache.brand.secondaryColor,
    logoUri: logoPath ? `file://${logoPath}` : null,
  });
}

/** Makes `next` the current config and pushes it. */
function adopt(next: CachedDisplay): Promise<void> {
  latest = next;
  return pushLatest();
}

async function allFilesPresent(cache: CachedDisplay): Promise<boolean> {
  if (!PosDisplay) return false;
  const names = [...(cache.logoFile ? [cache.logoFile] : []), ...cache.ads.map((a) => a.file)];
  for (const n of names) if (!(await PosDisplay.imagePath(n))) return false;
  return true;
}

/** Downloads (only when missing) and caches one image; null when the server says it doesn't exist (404). */
async function ensureImage(name: string, fetchImage: () => Promise<{ data_base64: string }>): Promise<string | null> {
  if (!PosDisplay) return null;
  if (await PosDisplay.imagePath(name)) return name;
  try {
    const img = await fetchImage();
    if (!img || typeof img.data_base64 !== 'string' || img.data_base64 === '') return null;
    await PosDisplay.saveImage(name, img.data_base64);
    return name;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e; // offline / server error: abandon this refresh, keep the previous cache
  }
}

async function doRefresh(): Promise<void> {
  if (!PosDisplay) return;
  const cfg: PosDisplayConfig = await api.display();
  await ensureLoaded();
  const cached = latest ?? (await readCache());
  if (cached && cached.version === cfg.version && (await allFilesPresent(cached))) {
    await adopt(cached);
    return;
  }

  // A changed logo has a new checksum → a new file name → downloaded here, and the display reloads it because its
  // path changed. has_logo false → logoFile null → logoPath null → the display drops the logo card.
  const logoFile =
    cfg.brand.has_logo && cfg.brand.logo_checksum
      ? await ensureImage(logoFileName(cfg.brand.logo_checksum), () => api.displayLogo())
      : null;
  const ads: CachedDisplay['ads'] = [];
  for (const ad of cfg.ads) {
    const file = await ensureImage(adFileName(ad.id, ad.checksum), () => api.displayAd(ad.id));
    if (file) ads.push({ id: ad.id, file, durationSeconds: Math.max(1, Math.round(ad.duration_seconds) || 10) });
  }

  const next: CachedDisplay = {
    version: cfg.version,
    brand: { name: cfg.brand.name, primaryColor: cfg.brand.primary_color, secondaryColor: cfg.brand.secondary_color },
    logoFile,
    ads,
  };
  await PosDisplay.writeConfigCache(JSON.stringify(next));
  await adopt(next);
  await PosDisplay.pruneImages([...(logoFile ? [logoFile] : []), ...ads.map((a) => a.file)]);
}

/**
 * The brand the customer display shows (name, colours, cached logo `file://` URI), from the device's cache — works
 * offline and with no cashier signed in. Null until the cache has been read (the first call starts reading it; use
 * {@link onDisplayBrandChange} to hear when it arrives), when nothing is cached yet, or without the display module
 * (Expo Go).
 */
export function cachedDisplayBrand(): DisplayBrand | null {
  if (!brand && !latest && PosDisplay) {
    void ensureLoaded()
      .then(() => (latest && !brand ? pushLatest() : undefined))
      .catch(() => undefined);
  }
  return brand;
}

/** Called whenever the cached brand changes (startup load, a refresh with a new name / colour / logo). Returns unsubscribe. */
export function onDisplayBrandChange(cb: (brand: DisplayBrand | null) => void): () => void {
  brandListeners.add(cb);
  return () => {
    brandListeners.delete(cb);
  };
}

export const displayService = {
  /** The customer display module is built in (not Expo Go / iOS / web). */
  get supported(): boolean {
    return PosDisplay !== null;
  },

  /** Pushes the cached config — no network, so it works offline (app start, hot-plug). Never throws. */
  async loadCached(): Promise<void> {
    try {
      await ensureLoaded();
      await pushLatest();
    } catch {
      // No cache yet / unreadable: the display keeps its default look until the next refresh.
    }
  },

  /** The cached config's `version` (what the real-time `hello` reports), or null — none yet / no display module. */
  async cachedVersion(): Promise<string | null> {
    try {
      await ensureLoaded();
      return latest?.version ?? null;
    } catch {
      return null;
    }
  },

  /** Re-fetches the config and changed images. One at a time; never throws. */
  refresh(): Promise<void> {
    if (!PosDisplay) return Promise.resolve();
    if (!inFlight) {
      inFlight = doRefresh()
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  },
};
