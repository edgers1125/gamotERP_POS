// The receipt logo (Settings → Receipts), cached on the device so receipts print it offline. Bootstrap carries only its
// checksum (bootstrap.receipt.logo_checksum); the image itself (GET /pos/receipt/logo) is downloaded only when that
// checksum isn't cached yet, and stored in the meta table (one logo — saving a new one drops the old).
import type { PosBootstrap } from '@pos-api/contract';
import { api } from '../api/client';
import { localStore } from '../db/localStore';

const isNotFound = (e: unknown) => !!e && typeof e === 'object' && (e as { status?: unknown }).status === 404;

function logoChecksum(b: PosBootstrap | null): string | null {
  const r = b?.receipt as { has_logo?: unknown; logo_checksum?: unknown } | null | undefined;
  return r && r.has_logo !== false && typeof r.logo_checksum === 'string' && r.logo_checksum !== '' ? r.logo_checksum : null;
}

let inFlight: Promise<boolean> | null = null;
let wanted: string | null = null; // the newest checksum asked for (a bootstrap re-read while a download runs)

async function downloadIfMissing(checksum: string): Promise<boolean> {
  try {
    if (await localStore.getReceiptLogo(checksum)) return false;
    const img = await api.receiptLogo();
    if (img && typeof img.data_base64 === 'string' && img.data_base64 !== '') {
      await localStore.saveReceiptLogo(checksum, img);
      return true;
    }
  } catch (e) {
    if (!isNotFound(e)) console.warn('[receipt] logo download failed', e);
  }
  return false;
}

/** Downloads the receipt logo when the bootstrap names one that isn't cached. Resolves true when a new logo was saved
 * (so screens holding the old one can re-read it). Never throws (offline keeps the cache). A newer checksum asked for
 * while a download runs is fetched right after it, never dropped. */
export function ensureReceiptLogo(b: PosBootstrap): Promise<boolean> {
  const checksum = logoChecksum(b);
  if (!checksum) return inFlight ?? Promise.resolve(false);
  wanted = checksum;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let saved = false;
    let done: string | null = null;
    while (wanted !== null && wanted !== done) {
      done = wanted;
      saved = (await downloadIfMissing(done)) || saved;
    }
    return saved;
  })().finally(() => {
    inFlight = null;
    wanted = null;
  });
  return inFlight;
}

/** The cached receipt logo as a data: URI, or null (no logo set, or not downloaded yet). */
export async function receiptLogoUri(b: PosBootstrap | null): Promise<string | null> {
  const checksum = logoChecksum(b);
  if (!checksum) return null;
  const img = await localStore.getReceiptLogo(checksum).catch(() => null);
  return img ? `data:${img.content_type || 'image/png'};base64,${img.data_base64}` : null;
}
