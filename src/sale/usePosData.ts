// The cached bootstrap + catalog the selling screens work from (local store — available offline). Reloaded whenever
// the screen gains focus and after each sync (the sync engine refreshes the caches when the server's catalog changes).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { PosBootstrap, PosCatalog, PosPaymentMethod, PosPricingChannel } from '@pos-api/contract';
import { api } from '../api/client';
import { cashierSession } from '../auth/cashierSession';
import { localStore } from '../db/localStore';
import { useSyncStatus } from '../sync/syncEngine';
import type { CartLine } from './cart';

export interface PosData {
  bootstrap: PosBootstrap | null;
  catalog: PosCatalog | null;
  loading: boolean;
  error: string | null;
  /** The terminal's effective payment methods. */
  methods: PosPaymentMethod[];
  /** Only channels the terminal has at least one payment method for. */
  channels: PosPricingChannel[];
  /** Cash's channel when the terminal takes cash, else the first. */
  defaultChannelId: number | null;
  reload: () => Promise<void>;
}

export function usePosData(): PosData {
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(null);
  const [catalog, setCatalog] = useState<PosCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sync = useSyncStatus();

  const reload = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([localStore.getBootstrap(), localStore.getCatalog()]);
      setBootstrap(b);
      setCatalog((prev) => (prev && c && prev.version === c.version ? prev : c));
      setError(b && c ? null : 'This terminal’s price list hasn’t been downloaded yet — connect to the server once.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t read the local data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  useEffect(() => {
    void reload();
  }, [reload, sync.lastSyncAt]);

  const methods = useMemo(() => bootstrap?.payment_methods ?? catalog?.payment_methods ?? [], [bootstrap, catalog]);
  const channels = useMemo(() => {
    const known = new Map<number, PosPricingChannel>();
    for (const c of [...(catalog?.pricing_channels ?? []), ...(bootstrap?.pricing_channels ?? [])]) known.set(c.id, c);
    const out: PosPricingChannel[] = [];
    for (const m of methods) {
      if (out.some((c) => c.id === m.pricing_channel_id)) continue;
      out.push(known.get(m.pricing_channel_id) ?? { id: m.pricing_channel_id, name: `Channel ${m.pricing_channel_id}` });
    }
    return out;
  }, [methods, bootstrap, catalog]);
  const defaultChannelId = useMemo(() => {
    const cash = methods.find((m) => m.kind === 'CASH');
    return cash?.pricing_channel_id ?? channels[0]?.id ?? null;
  }, [methods, channels]);

  return { bootstrap, catalog, loading, error, methods, channels, defaultChannelId, reload };
}

/**
 * Online hint of unexpired on-shelf stock for the cart's SKUs (GET /pos/stock — needs an online cashier session). A
 * sale the recorded stock can't cover is still recorded (OVERSOLD at sync), so this only drives the "will be
 * Oversold" note. Offline → no hint.
 */
export function useStockHint(lines: CartLine[], online: boolean, onStock: (stock: Record<number, number>) => void): void {
  const key = lines
    .map((l) => l.skuId)
    .sort((a, b) => a - b)
    .join(',');
  const seq = useRef(0);
  useEffect(() => {
    if (!online || key === '' || cashierSession.current()?.mode !== 'ONLINE') return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .stock(key.split(',').map(Number))
        .then((rows) => {
          if (mine !== seq.current) return;
          onStock(Object.fromEntries(rows.map((r) => [r.sku_id, r.available])));
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online]);
}
