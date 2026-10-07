// The open cash drawer session as UI state (zustand), following the local store: re-read after every local write
// (a drawer op, a sale, a sync result, a bootstrap refresh…). The selling gate (`useDrawerGate`) is the ONE place the
// Sell and Payment screens ask whether the drawer lets them sell; localStore.recordSale enforces the same rule
// (drawerSellProblem), so a stale screen can never slip a sale past a closed drawer.
import { useEffect } from 'react';
import { create } from 'zustand';

import { onLocalStoreEvent } from '../db/events';
import { localStore } from '../db/localStore';
import { drawerSellProblem, type LocalDrawerSession } from './cashDrawer';

interface CashDrawerState {
  loaded: boolean;
  open: LocalDrawerSession | null;
  /** This device's terminal (bootstrap, else enrollment). */
  terminalId: number | null;
  refresh(): Promise<void>;
}

let seq = 0;

export const useCashDrawer = create<CashDrawerState>()((set) => ({
  loaded: false,
  open: null,
  terminalId: null,
  async refresh() {
    const mine = ++seq;
    try {
      const [open, bootstrap, enrollment] = await Promise.all([
        localStore.getOpenDrawerSession(),
        localStore.getBootstrap(),
        localStore.getEnrollment(),
      ]);
      if (mine !== seq) return; // a newer refresh started meanwhile — it wins
      set({ loaded: true, open, terminalId: bootstrap?.terminal.id ?? enrollment?.terminal.id ?? null });
    } catch {
      if (mine === seq) set({ loaded: true });
    }
  },
}));

let subscribed = false;
/** Starts following the local store (once) and reads the current state. */
export function useCashDrawerSync(): void {
  useEffect(() => {
    if (!subscribed) {
      subscribed = true;
      onLocalStoreEvent(() => void useCashDrawer.getState().refresh());
    }
    void useCashDrawer.getState().refresh();
  }, []);
}

export const CHECKING_DRAWER_MESSAGE = 'Checking the cash drawer…';

export interface DrawerGate {
  /** Why the drawer blocks selling right now (null = an open session on this terminal). */
  problem: string | null;
  /** True until the first read finished (problem is the "checking" text meanwhile — no banner for it). */
  checking: boolean;
}

/** The selling gate: Charge / Complete sale stay disabled while `problem` is set. */
export function useDrawerGate(): DrawerGate {
  useCashDrawerSync();
  const loaded = useCashDrawer((s) => s.loaded);
  const open = useCashDrawer((s) => s.open);
  const terminalId = useCashDrawer((s) => s.terminalId);
  if (!loaded) return { problem: CHECKING_DRAWER_MESSAGE, checking: true };
  return { problem: drawerSellProblem(open, terminalId), checking: false };
}
