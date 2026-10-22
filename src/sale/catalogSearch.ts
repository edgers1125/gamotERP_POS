// Product search over the CACHED catalog (works offline): the local store's indexed search / barcode lookup
// (`localStore.searchCatalog` / `findByBarcode`), with an in-memory fallback over the cached catalog should the
// database read fail.
import type { PosCatalog, PosCatalogItem } from '@pos-api/contract';
import { localStore } from '../db/localStore';

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Strict picking: an item with a barcode in the synced catalog (`barcodes` = its active barcodes) can't be picked by name. */
export function hasBarcode(item: PosCatalogItem): boolean {
  return item.barcodes.length > 0;
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

/**
 * Name search under the strict-pick rule: items WITH a barcode are left out (scan them or type the exact SKU code)
 * unless `override` (cashier holds itemtracker.pickoverride and turned override on for this sale).
 */
export async function searchCatalogStrict(query: string, catalog: PosCatalog | null, override: boolean, limit = 60): Promise<PosCatalogItem[]> {
  if (override) return searchCatalog(query, catalog, limit);
  if (query.trim() === '') return (catalog?.items ?? []).filter((i) => !hasBarcode(i)).slice(0, limit);
  // Over-fetch: the barcoded matches are dropped afterwards.
  const rows = await searchCatalog(query, catalog, limit * 4);
  return rows.filter((i) => !hasBarcode(i)).slice(0, limit);
}

/** Exact SKU code (case-insensitive, no prefix). 'many' when two items share the code (scan the barcode instead). */
export function findBySkuCode(code: string, catalog: PosCatalog | null): PosCatalogItem | 'many' | null {
  const c = code.trim().toLowerCase();
  if (c === '') return null;
  const hits = (catalog?.items ?? []).filter((i) => i.sku_code.toLowerCase() === c);
  return hits.length === 0 ? null : hits.length === 1 ? hits[0]! : 'many';
}

/** Exact barcode only (a scan). The SKU code is looked up separately with findBySkuCode. */
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
  return items.find((i) => i.barcodes.includes(code)) ?? null;
}

// ---- grouping by product model (the Sell screen shows one tile per model) ---------------------------------------

/** One Sell-screen tile: a product model and the SKUs (pack sizes / variants) of it that are on offer. */
export interface CatalogGroup {
  key: string;
  name: string;
  items: PosCatalogItem[];
}

// A catalog cached on the device before model_id/model_name/variant_label existed lacks them at runtime.
type MaybeModelFields = Partial<Pick<PosCatalogItem, 'model_id' | 'model_name' | 'variant_label'>>;

/** The group key of an item: its model, or the SKU itself when it has no model (or the catalog predates models). */
export function groupKeyOf(item: PosCatalogItem): string {
  const m = (item as MaybeModelFields).model_id;
  return m != null ? `model:${m}` : `sku:${item.sku_id}`;
}

/** What sets a SKU apart within its model ("10 PCS", "Tablet - 100 PCS"), falling back to the full name. */
export function variantLabelOf(item: PosCatalogItem): string {
  const v = (item as MaybeModelFields).variant_label;
  return v != null && v !== '' ? v : item.final_name;
}

/** Groups items by model, keeping the order in which each model first appears (catalog / search order). */
export function groupByModel(items: PosCatalogItem[]): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const item of items) {
    const key = groupKeyOf(item);
    let g = groups.get(key);
    if (!g) {
      const f = item as MaybeModelFields;
      const name = key.startsWith('model:') && f.model_name ? f.model_name : item.final_name;
      g = { key, name, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  return [...groups.values()];
}
