import type { PosApprovalKind, PosApprover } from '@pos-api/contract';

import { api } from '../../api/client';
import { cashierSession } from '../../auth/cashierSession';
import { localStore } from '../../db/localStore';

/** The eligible co-signers for `kind`: the cached list, refreshed from the server (and re-cached) when an online
 * cashier session is available. Falls back to the cache on any error. */
export async function loadApprovers(kind: PosApprovalKind, online: boolean): Promise<PosApprover[]> {
  const cached = await localStore.getApprovers(kind).catch(() => [] as PosApprover[]);
  if (!online || !cashierSession.isOnlineSession()) return cached;
  try {
    const fresh = await api.approvers(kind);
    await localStore.saveApprovers(kind, fresh).catch(() => undefined);
    return fresh;
  } catch {
    return cached;
  }
}
