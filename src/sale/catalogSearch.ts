// Product search over the CACHED catalog (works offline): the local store's indexed search / barcode lookup
// (`localStore.searchCatalog` / `findByBarcode`), with an in-memory fallback over the cached catalog should the
// database read fail.
import type { PosCatalog, PosCatalogItem } from '@pos-api/contract';
import { localStore } from '../db/localStore';

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Every word of the query must appear in the name, SKU code or a barcode. */
export function filterCatalog(items: PosCatalogItem[], query: string, limit: number): PosCatalogItem[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const out: PosCatalogItem[] = [];
  for (const item of items) {
    const hay = norm(`${item.final_name} ${item.sku_code} ${item.barcodes.join(' ')}`);
    if (words.every((w) => hay.includes(w))) {
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function searchCatalog(query: string, catalog: PosCatalog | null, limit = 60): Promise<PosCatalogItem[]> {
  try {
    const rows = await localStore.searchCatalog(query.trim(), limit);
    // The store matches the whole query as one phrase; a multi-word query that finds nothing there ("para 500") is
    // retried word by word in memory.
    if (rows.length > 0 || !/\s/.test(query.trim()) || !catalog) return rows;
  } catch {
    // fall through to the in-memory search
  }
  return filterCatalog(catalog?.items ?? [], query, limit);
}

export async function findByBarcode(barcode: string, catalog: PosCatalog | null): Promise<PosCatalogItem | null> {
  const code = barcode.trim();
  if (code === '') return null;
  try {
    const hit = await localStore.findByBarcode(code);
    if (hit) return hit;
  } catch {
    // fall through
  }
  const items = catalog?.items ?? [];
  return items.find((i) => i.barcodes.includes(code)) ?? items.find((i) => i.sku_code.toLowerCase() === code.toLowerCase()) ?? null;
}
