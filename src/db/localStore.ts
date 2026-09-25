// P-A2 — the POS app's local, SQLCipher-encrypted store (contract: src/contracts.ts `LocalStore`).
//
// Invoice numbers: the device owns its counters. `recordSale` runs under `counterLock` (one sale at a time, and
// nothing else that writes counters can interleave), reads the next seq, builds + signs the payload OUTSIDE any SQL
// transaction (signing is async native work), then in ONE SQL transaction re-checks that the counter still holds that
// seq, advances it, inserts the sale and inserts its signed outbox op. So a number is either fully used (counter
// advanced + sale saved + op queued) or not used at all — never printed-but-unsaved, reused or skipped.
//
// Outbox rows are never deleted: PENDING → DONE (RECORDED / DUPLICATE) or REJECTED (kept and shown to a manager — the
// server stores results by client_uuid, so re-sending the same op would only return the same rejection).
import * as Crypto from 'expo-crypto';

import { canonicalJson } from '@pos-api/contract';
import type {
  PosApprovalKind,
  PosApprover,
  PosBootstrap,
  PosCatalog,
  PosCatalogItem,
  PosCounters,
  PosTerminalInfo,
  SalePayload,
  SyncOp,
  SyncOpResult,
  VoidPayload,
} from '@pos-api/contract';
import { businessDate } from '@shared/business-day';
import { formatInvoiceNumber } from '@shared/invoice-number';

import type { EnrollmentState, LocalSale, LocalStore } from '../contracts';
import { jose } from '../device/jose';
import { initDatabase, json, jsonOrNull, num, rows, str, strOrNull, withDb, type BatchCommand, type Conn, type Row } from './database';
import { emitLocalStoreEvent } from './events';
import { Mutex } from './mutex';
import { APP_VERSION, blockReason, compareVersions, UNKNOWN_MIN_VERSION } from './policy';

const counterLock = new Mutex();

const META_REVOKED = 'revoked';
const META_UPDATE_REQUIRED = 'update_required';

type SyncState = LocalSale['sync_status'];

// ---- mapping ------------------------------------------------------------------------------------------------------

function saleFromRow(r: Row): LocalSale {
  const voidedAt = strOrNull(r.voided_at);
  return {
    client_uuid: str(r.client_uuid),
    invoice_number: str(r.invoice_number),
    payload: json<SalePayload>(r.payload_json),
    sync_status: str(r.sync_status) as SyncState,
    sync_result: jsonOrNull<SyncOpResult>(r.sync_result_json),
    voided: voidedAt
      ? {
          voided_at: voidedAt,
          reason: strOrNull(r.void_reason) ?? '',
          sync_status: (strOrNull(r.void_sync_status) ?? 'PENDING') as SyncState,
        }
      : null,
    refunded: num(r.refunded) === 1,
  };
}

function opFromRow(r: Row): SyncOp {
  return {
    client_uuid: str(r.client_uuid),
    type: str(r.type) as SyncOp['type'],
    created_at: str(r.created_at),
    payload: json<SalePayload | VoidPayload>(r.payload_json),
    signature: str(r.signature),
  };
}

/** RECORDED / DUPLICATE → the server has it; a DUPLICATE carrying an error means the stored result was a rejection. */
function syncStateOf(result: SyncOpResult): SyncState {
  if (result.status === 'RECORDED') return 'RECORDED';
  if (result.status === 'DUPLICATE') return result.error ? 'REJECTED' : 'RECORDED';
  return 'REJECTED';
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- internal reads (call inside withDb) ----------------------------------------------------------------------------

async function readEnrollment(conn: Conn): Promise<EnrollmentState | null> {
  const r = rows(await conn.execute('SELECT device_id, terminal_json, enrolled_at FROM enrollment WHERE id = 1'))[0];
  if (!r) return null;
  return { device_id: num(r.device_id), terminal: json<PosTerminalInfo>(r.terminal_json), enrolled_at: str(r.enrolled_at) };
}

async function readCounters(conn: Conn): Promise<PosCounters | null> {
  const r = rows(await conn.execute('SELECT next_invoice_number, next_return_number FROM counters WHERE id = 1'))[0];
  if (!r) return null;
  return { next_invoice_number: num(r.next_invoice_number), next_return_number: num(r.next_return_number) };
}

async function readBootstrap(conn: Conn): Promise<PosBootstrap | null> {
  const r = rows(await conn.execute('SELECT json FROM bootstrap_cache WHERE id = 1'))[0];
  return r ? json<PosBootstrap>(r.json) : null;
}

async function readMeta(conn: Conn, key: string): Promise<string | null> {
  const r = rows(await conn.execute('SELECT value FROM meta WHERE key = ?', [key]))[0];
  return r ? str(r.value) : null;
}

async function readPending(conn: Conn): Promise<{ count: number; oldestAt: string | null; offlineSales: number }> {
  const c = rows(
    await conn.execute(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN type = 'SALE' THEN 1 ELSE 0 END) AS sales FROM outbox WHERE status = 'PENDING'`,
    ),
  )[0];
  const oldest = rows(await conn.execute(`SELECT created_at FROM outbox WHERE status = 'PENDING' ORDER BY id LIMIT 1`))[0];
  return {
    count: c ? num(c.n) : 0,
    oldestAt: oldest ? str(oldest.created_at) : null,
    offlineSales: c && c.sales !== null && c.sales !== undefined ? num(c.sales) : 0,
  };
}

/** The persisted update-required flag, ignored once this build is new enough (or is a different build than the one
 * that was refused — the next call re-checks). */
async function readUpdateRequired(conn: Conn): Promise<string | null> {
  const raw = await readMeta(conn, META_UPDATE_REQUIRED);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { min: string | null; app_version: string };
    if (v.app_version !== APP_VERSION) return null;
    if (v.min && compareVersions(APP_VERSION, v.min) >= 0) return null;
    return v.min ?? UNKNOWN_MIN_VERSION;
  } catch {
    return null;
  }
}

/** Terminal settings: the latest bootstrap's, else the enrollment snapshot's. */
async function readTerminal(conn: Conn): Promise<PosTerminalInfo | null> {
  const b = await readBootstrap(conn);
  if (b) return b.terminal;
  return (await readEnrollment(conn))?.terminal ?? null;
}

// ---- catalog item cache (in memory, rebuilt from SQL on demand) ----------------------------------------------------

let catalogMemo: PosCatalog | null = null;

// ---- the store ------------------------------------------------------------------------------------------------------

export interface LocalStoreExtras {
  /** Items whose name or sku_code contains `query` (case-insensitive) or whose barcode starts with it; catalog order,
   * names starting with the query first. Empty query → first `limit` items. */
  searchCatalog(query: string, limit?: number): Promise<PosCatalogItem[]>;
  /** The item with this exact barcode (first in catalog order when several SKUs share it), or null. */
  findByBarcode(code: string): Promise<PosCatalogItem | null>;
  /** Every item with this exact barcode. */
  findAllByBarcode(code: string): Promise<PosCatalogItem[]>;
  /** Mark a local sale refunded (after POST /pos/refunds succeeded). */
  markRefunded(saleUuid: string): Promise<void>;
  /** Record a failed send attempt (the whole batch failed — network/5xx). The ops stay PENDING. */
  markAttempt(clientUuids: string[], error: string | null): Promise<void>;
  /** Raise the device counters to at least the server's expected ones (never lowers them). */
  raiseCounters(server: PosCounters): Promise<void>;
  /** Flags that block selling, persisted across restarts. */
  getFlags(): Promise<{ revoked: boolean; updateRequired: string | null }>;
  setRevoked(revoked: boolean): Promise<void>;
  /** `min` = the server's min_app_version (null when unknown); null clears. */
  setUpdateRequired(min: string | null | undefined): Promise<void>;
  /** Why selling is blocked (revoked / update / offline limits), computed from the DB — or null. */
  sellingBlockedReason(): Promise<string | null>;
  /** Number of REJECTED ops. */
  rejectedCount(): Promise<number>;
  /** The cached catalog's version, without loading the whole catalog. */
  getCatalogVersion(): Promise<string | null>;
}

export const localStore: LocalStore & LocalStoreExtras = {
  async init() {
    await initDatabase();
  },

  // ---------------------------------------------------------------- enrollment / bootstrap / catalog caches

  getEnrollment() {
    return withDb(readEnrollment);
  },

  async saveEnrollment(e, counters) {
    if (!(counters.next_invoice_number >= 1) || !(counters.next_return_number >= 1)) {
      throw new Error('Invalid counters from the server');
    }
    await counterLock.run(() =>
      withDb((conn) =>
        conn.transaction(async (tx) => {
          const now = new Date().toISOString();
          await tx.execute(
            'INSERT OR REPLACE INTO enrollment (id, device_id, terminal_json, enrolled_at) VALUES (1, ?, ?, ?)',
            [e.device_id, JSON.stringify(e.terminal), e.enrolled_at],
          );
          await tx.execute(
            'INSERT OR REPLACE INTO counters (id, next_invoice_number, next_return_number, updated_at) VALUES (1, ?, ?, ?)',
            [counters.next_invoice_number, counters.next_return_number, now],
          );
          await tx.execute('DELETE FROM meta WHERE key IN (?, ?)', [META_REVOKED, META_UPDATE_REQUIRED]);
        }),
      ),
    );
    emitLocalStoreEvent('changed');
  },

  async clearEnrollment() {
    // Sales and the outbox are KEPT (never drop an op): anything still pending is sent after re-enrollment and, if the
    // server can't accept it under the new device, comes back REJECTED and stays visible.
    await counterLock.run(() =>
      withDb((conn) =>
        conn.transaction(async (tx) => {
          for (const t of ['enrollment', 'counters', 'bootstrap_cache', 'catalog_cache', 'catalog_items', 'catalog_barcodes', 'approvers', 'pin_verifiers']) {
            await tx.execute(`DELETE FROM ${t}`);
          }
          await tx.execute('DELETE FROM meta WHERE key IN (?, ?)', [META_REVOKED, META_UPDATE_REQUIRED]);
        }),
      ),
    );
    catalogMemo = null;
    emitLocalStoreEvent('changed');
  },

  getBootstrap() {
    return withDb(readBootstrap);
  },

  async saveBootstrap(b) {
    await withDb((conn) =>
      conn.execute('INSERT OR REPLACE INTO bootstrap_cache (id, json, saved_at) VALUES (1, ?, ?)', [
        JSON.stringify(b),
        new Date().toISOString(),
      ]),
    );
    emitLocalStoreEvent('changed');
  },

  async getCatalog() {
    if (catalogMemo) return catalogMemo;
    const c = await withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT json FROM catalog_cache WHERE id = 1'))[0];
      return r ? json<PosCatalog>(r.json) : null;
    });
    catalogMemo = c;
    return c;
  },

  async saveCatalog(c) {
    const now = new Date().toISOString();
    const itemParams: (string | number)[][] = c.items.map((it, i) => [
      it.sku_id,
      i,
      it.sku_code,
      it.sku_code.toLowerCase(),
      it.final_name,
      it.final_name.toLowerCase(),
      JSON.stringify(it),
    ]);
    const barcodeParams: (string | number)[][] = [];
    for (const it of c.items) for (const b of new Set(it.barcodes)) if (b) barcodeParams.push([b, it.sku_id]);
    const cmds: BatchCommand[] = [
      ['DELETE FROM catalog_barcodes'],
      ['DELETE FROM catalog_items'],
      ['INSERT OR REPLACE INTO catalog_cache (id, version, json, saved_at) VALUES (1, ?, ?, ?)', [c.version, JSON.stringify(c), now]],
    ];
    if (itemParams.length) {
      cmds.push([
        'INSERT OR REPLACE INTO catalog_items (sku_id, position, sku_code, sku_code_lc, final_name, name_lc, item_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        itemParams,
      ]);
    }
    if (barcodeParams.length) cmds.push(['INSERT OR IGNORE INTO catalog_barcodes (barcode, sku_id) VALUES (?, ?)', barcodeParams]);
    // executeBatch runs every command in ONE transaction (op-sqlite) — the cache is replaced atomically.
    await withDb((conn) => conn.executeBatch(cmds));
    catalogMemo = c;
    emitLocalStoreEvent('changed');
  },

  async getCatalogVersion() {
    if (catalogMemo) return catalogMemo.version;
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT version FROM catalog_cache WHERE id = 1'))[0];
      return r ? str(r.version) : null;
    });
  },

  async searchCatalog(query, limit = 50) {
    const q = query.trim().toLowerCase();
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    return withDb(async (conn) => {
      if (!q) {
        return rows(await conn.execute('SELECT item_json FROM catalog_items ORDER BY position LIMIT ?', [lim])).map((r) =>
          json<PosCatalogItem>(r.item_json),
        );
      }
      const like = `%${escapeLike(q)}%`;
      const prefix = `${escapeLike(q)}%`;
      const res = await conn.execute(
        `SELECT item_json FROM catalog_items
          WHERE name_lc LIKE ? ESCAPE '\\'
             OR sku_code_lc LIKE ? ESCAPE '\\'
             OR sku_id IN (SELECT sku_id FROM catalog_barcodes WHERE barcode LIKE ? ESCAPE '\\')
          ORDER BY CASE WHEN sku_code_lc = ? THEN 0 WHEN name_lc LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, position
          LIMIT ?`,
        [like, like, prefix, q, prefix, lim],
      );
      return rows(res).map((r) => json<PosCatalogItem>(r.item_json));
    });
  },

  async findAllByBarcode(code) {
    const c = code.trim();
    if (!c) return [];
    return withDb(async (conn) =>
      rows(
        await conn.execute(
          `SELECT i.item_json FROM catalog_barcodes b JOIN catalog_items i ON i.sku_id = b.sku_id
            WHERE b.barcode = ? ORDER BY i.position`,
          [c],
        ),
      ).map((r) => json<PosCatalogItem>(r.item_json)),
    );
  },

  async findByBarcode(code) {
    return (await localStore.findAllByBarcode(code))[0] ?? null;
  },

  async getApprovers(kind: PosApprovalKind) {
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT list_json FROM approvers WHERE kind = ?', [kind]))[0];
      return r ? json<PosApprover[]>(r.list_json) : [];
    });
  },

  async saveApprovers(kind, list) {
    await withDb((conn) =>
      conn.execute('INSERT OR REPLACE INTO approvers (kind, list_json, saved_at) VALUES (?, ?, ?)', [
        kind,
        JSON.stringify(list),
        new Date().toISOString(),
      ]),
    );
  },

  // ---------------------------------------------------------------- counters

  async getCounters() {
    const c = await withDb(readCounters);
    if (!c) throw new Error('This device is not enrolled — it has no invoice counters.');
    return c;
  },

  async raiseCounters(server) {
    await counterLock.run(() =>
      withDb((conn) =>
        conn.execute(
          `UPDATE counters SET next_invoice_number = MAX(next_invoice_number, ?),
                               next_return_number = MAX(next_return_number, ?),
                               updated_at = ?
            WHERE id = 1 AND (next_invoice_number < ? OR next_return_number < ?)`,
          [
            server.next_invoice_number,
            server.next_return_number,
            new Date().toISOString(),
            server.next_invoice_number,
            server.next_return_number,
          ],
        ),
      ),
    );
  },

  recordSale(build) {
    return counterLock.run(async () => {
      // 1. Read state (committed — nothing else writes counters while counterLock is held).
      const pre = await withDb(async (conn) => ({
        enrollment: await readEnrollment(conn),
        counters: await readCounters(conn),
        terminal: await readTerminal(conn),
        pending: await readPending(conn),
        revoked: (await readMeta(conn, META_REVOKED)) === '1',
        updateRequired: await readUpdateRequired(conn),
      }));
      if (!pre.enrollment || !pre.counters || !pre.terminal) throw new Error('This device is not enrolled.');
      const blocked = blockReason({
        revoked: pre.revoked,
        updateRequired: pre.updateRequired,
        terminal: pre.terminal,
        pendingOldestAt: pre.pending.oldestAt,
        pendingSales: pre.pending.offlineSales,
      });
      if (blocked) throw new Error(blocked);

      // 2. Build + sign outside the SQL transaction (the seq can't be taken by anyone else: counterLock).
      const seq = pre.counters.next_invoice_number;
      const payload = build(seq);
      if (payload.invoice_seq !== seq) throw new Error(`Sale payload has invoice_seq ${payload.invoice_seq}, expected ${seq}`);
      const payloadJson = canonicalJson(payload);
      const signature = await jose.signOpPayload(payload);
      const clientUuid = Crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const soldAt = new Date(payload.sold_at);
      if (Number.isNaN(soldAt.getTime())) throw new Error('Sale payload has an invalid sold_at');
      const invoiceNumber = formatInvoiceNumber(pre.terminal.invoice_prefix, 'SALE', seq);
      const deviceId = pre.enrollment.device_id;

      // 3. ONE transaction: counter + sale + outbox op.
      await withDb((conn) =>
        conn.transaction(async (tx) => {
          const cur = rows(await tx.execute('SELECT next_invoice_number FROM counters WHERE id = 1'))[0];
          if (!cur || num(cur.next_invoice_number) !== seq) throw new Error('The invoice counter changed during the sale — try again.');
          await tx.execute('UPDATE counters SET next_invoice_number = ?, updated_at = ? WHERE id = 1', [seq + 1, createdAt]);
          await tx.execute(
            `INSERT INTO sales (client_uuid, device_id, invoice_seq, invoice_number, business_date, sold_at, payload_json,
                                sync_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
            [clientUuid, deviceId, seq, invoiceNumber, businessDate(soldAt), payload.sold_at, payloadJson, createdAt],
          );
          await tx.execute(
            `INSERT INTO outbox (client_uuid, type, created_at, payload_json, signature, device_id, status)
             VALUES (?, 'SALE', ?, ?, ?, ?, 'PENDING')`,
            [clientUuid, createdAt, payloadJson, signature, deviceId],
          );
        }),
      );
      emitLocalStoreEvent('enqueued');
      const sale: LocalSale = {
        client_uuid: clientUuid,
        invoice_number: invoiceNumber,
        payload: JSON.parse(payloadJson) as SalePayload,
        sync_status: 'PENDING',
        sync_result: null,
        voided: null,
        refunded: false,
      };
      return sale;
    });
  },

  async recordVoid(saleUuid, payload) {
    if (payload.sale_client_uuid !== saleUuid) throw new Error('Void payload is for a different sale');
    const voidedAt = new Date(payload.voided_at);
    if (Number.isNaN(voidedAt.getTime())) throw new Error('Void payload has an invalid voided_at');
    const pre = await withDb(async (conn) => ({
      enrollment: await readEnrollment(conn),
      revoked: (await readMeta(conn, META_REVOKED)) === '1',
      sale: rows(await conn.execute('SELECT voided_at, sync_status FROM sales WHERE client_uuid = ?', [saleUuid]))[0],
    }));
    if (!pre.enrollment) throw new Error('This device is not enrolled.');
    if (pre.revoked) throw new Error('This device has been revoked.');
    if (!pre.sale) throw new Error('Sale not found on this device');
    if (strOrNull(pre.sale.voided_at)) throw new Error('This sale is already voided');
    if (str(pre.sale.sync_status) === 'REJECTED') throw new Error('This sale was rejected by the server and cannot be voided');

    const payloadJson = canonicalJson(payload);
    const signature = await jose.signOpPayload(payload);
    const clientUuid = Crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        const upd = await tx.execute(
          `UPDATE sales SET void_client_uuid = ?, voided_at = ?, void_reason = ?, void_sync_status = 'PENDING'
            WHERE client_uuid = ? AND voided_at IS NULL`,
          [clientUuid, payload.voided_at, payload.reason, saleUuid],
        );
        if (upd.rowsAffected !== 1) throw new Error('This sale is already voided');
        await tx.execute(
          `INSERT INTO outbox (client_uuid, type, created_at, payload_json, signature, device_id, status)
           VALUES (?, 'VOID', ?, ?, ?, ?, 'PENDING')`,
          [clientUuid, createdAt, payloadJson, signature, pre.enrollment!.device_id],
        );
      }),
    );
    emitLocalStoreEvent('enqueued');
  },

  async peekReturnSeq() {
    return (await localStore.getCounters()).next_return_number;
  },

  async commitReturnSeq(used) {
    if (!Number.isInteger(used) || used < 1) throw new Error('Invalid return number');
    await counterLock.run(() =>
      withDb((conn) =>
        conn.execute('UPDATE counters SET next_return_number = MAX(next_return_number, ?), updated_at = ? WHERE id = 1', [
          used + 1,
          new Date().toISOString(),
        ]),
      ),
    );
  },

  async markRefunded(saleUuid) {
    await withDb((conn) => conn.execute('UPDATE sales SET refunded = 1 WHERE client_uuid = ?', [saleUuid]));
    emitLocalStoreEvent('changed');
  },

  listSales(date) {
    return withDb(async (conn) =>
      rows(await conn.execute('SELECT * FROM sales WHERE business_date = ? ORDER BY sold_at DESC, invoice_seq DESC', [date])).map(
        saleFromRow,
      ),
    );
  },

  getSale(clientUuid) {
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT * FROM sales WHERE client_uuid = ?', [clientUuid]))[0];
      return r ? saleFromRow(r) : null;
    });
  },

  // ---------------------------------------------------------------- outbox

  pendingOps(limit) {
    const lim = Math.max(1, Math.floor(limit));
    // Insertion order (id), not created_at: a device clock jump must never send a VOID before its SALE.
    return withDb(async (conn) =>
      rows(await conn.execute(`SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY id LIMIT ?`, [lim])).map(opFromRow),
    );
  },

  pendingCount() {
    return withDb(readPending);
  },

  async applyResults(results) {
    if (!results.length) return;
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        const now = new Date().toISOString();
        for (const result of results) {
          const op = rows(await tx.execute('SELECT type FROM outbox WHERE client_uuid = ?', [result.client_uuid]))[0];
          if (!op) continue; // not ours (shouldn't happen) — ignore rather than fail the batch
          const state = syncStateOf(result);
          await tx.execute(
            `UPDATE outbox SET status = ?, result_json = ?, done_at = ?, last_error = ? WHERE client_uuid = ?`,
            [state === 'REJECTED' ? 'REJECTED' : 'DONE', JSON.stringify(result), now, result.error, result.client_uuid],
          );
          if (str(op.type) === 'SALE') {
            await tx.execute('UPDATE sales SET sync_status = ?, sync_result_json = ? WHERE client_uuid = ?', [
              state,
              JSON.stringify(result),
              result.client_uuid,
            ]);
          } else {
            await tx.execute('UPDATE sales SET void_sync_status = ? WHERE void_client_uuid = ?', [state, result.client_uuid]);
          }
        }
      }),
    );
    emitLocalStoreEvent('changed');
  },

  async markAttempt(clientUuids, error) {
    if (!clientUuids.length) return;
    const now = new Date().toISOString();
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        for (const id of clientUuids) {
          await tx.execute(
            `UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE client_uuid = ? AND status = 'PENDING'`,
            [now, error, id],
          );
        }
      }),
    );
  },

  rejectedOps() {
    return withDb(async (conn) =>
      rows(await conn.execute(`SELECT * FROM outbox WHERE status = 'REJECTED' ORDER BY id`)).map((r) => ({
        op: opFromRow(r),
        result:
          jsonOrNull<SyncOpResult>(r.result_json) ??
          ({
            client_uuid: str(r.client_uuid),
            status: 'REJECTED',
            batch_id: null,
            reference: null,
            invoice_number: null,
            stock_status: null,
            exceptions: [],
            error: strOrNull(r.last_error),
          } satisfies SyncOpResult),
      })),
    );
  },

  rejectedCount() {
    return withDb(async (conn) => num(rows(await conn.execute(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'REJECTED'`))[0]?.n ?? 0));
  },

  // ---------------------------------------------------------------- flags / policy

  getFlags() {
    return withDb(async (conn) => ({
      revoked: (await readMeta(conn, META_REVOKED)) === '1',
      updateRequired: await readUpdateRequired(conn),
    }));
  },

  async setRevoked(revoked) {
    await withDb((conn) =>
      revoked
        ? conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_REVOKED, '1'])
        : conn.execute('DELETE FROM meta WHERE key = ?', [META_REVOKED]),
    );
    emitLocalStoreEvent('changed');
  },

  async setUpdateRequired(min) {
    await withDb((conn) =>
      min === null
        ? conn.execute('DELETE FROM meta WHERE key = ?', [META_UPDATE_REQUIRED])
        : conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
            META_UPDATE_REQUIRED,
            JSON.stringify({ min: min ?? null, app_version: APP_VERSION }),
          ]),
    );
    emitLocalStoreEvent('changed');
  },

  sellingBlockedReason() {
    return withDb(async (conn) => {
      const pending = await readPending(conn);
      return blockReason({
        revoked: (await readMeta(conn, META_REVOKED)) === '1',
        updateRequired: await readUpdateRequired(conn),
        terminal: await readTerminal(conn),
        pendingOldestAt: pending.oldestAt,
        pendingSales: pending.offlineSales,
      });
    });
  },

  // ---------------------------------------------------------------- offline cashier PINs

  async savePinVerifier(userId, name, email, permissions, verifier) {
    await withDb((conn) =>
      conn.execute(
        'INSERT OR REPLACE INTO pin_verifiers (user_id, name, email, permissions_json, verifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, name, email, JSON.stringify(permissions), verifier, new Date().toISOString()],
      ),
    );
  },

  getPinVerifier(userId) {
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT * FROM pin_verifiers WHERE user_id = ?', [userId]))[0];
      if (!r) return null;
      return {
        userId: num(r.user_id),
        name: str(r.name),
        email: str(r.email),
        permissions: json<string[]>(r.permissions_json),
        verifier: str(r.verifier),
      };
    });
  },

  listPinUsers() {
    return withDb(async (conn) =>
      rows(await conn.execute('SELECT user_id, name FROM pin_verifiers ORDER BY name COLLATE NOCASE')).map((r) => ({
        userId: num(r.user_id),
        name: str(r.name),
      })),
    );
  },
};
