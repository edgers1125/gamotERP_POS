// Change notifications from localStore, so the sync engine can refresh its counts and sync right after a sale
// without the store depending on the engine. `kind`: 'enqueued' = a new op is in the outbox (sync it now),
// 'changed' = sync state / flags changed (refresh the status only).
export type LocalStoreEvent = 'enqueued' | 'changed';
type Listener = (e: LocalStoreEvent) => void;

const listeners = new Set<Listener>();

export function onLocalStoreEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitLocalStoreEvent(e: LocalStoreEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      // A listener's failure must never fail the write that already committed.
    }
  }
}
