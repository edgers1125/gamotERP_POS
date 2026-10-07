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
  DrawerClosePayload,
  DrawerMovementKind,
  DrawerMovementPayload,
  DrawerOpenPayload,
  PosApprovalKind,
  PosApprover,
  PosBrand,
  PosBootstrap,
  PosCatalog,
  PosCatalogItem,
  PosCounters,
  PosDisplayImage,
  PosPaymentMethod,
  PosTerminalInfo,
  SalePayload,
  SyncOp,
  SyncOpResult,
} from '@pos-api/contract';
import { businessDate } from '@shared/business-day';
import { formatInvoiceNumber } from '@shared/invoice-number';

import type { EnrollmentState, LocalSale, LocalStore } from '../contracts';
import { jose } from '../device/jose';
import { EMPTY_LICENSE_RECORD, type LeaseIds, type LicenseEvaluation, type LicenseRecord } from '../license/lease';
import { evaluateStoredLicense, FLOOR_PERSIST_STEP_MS } from '../license/licenseEval';
import {
  DRAWER_MAX_AMOUNT,
  DRAWER_NOTE_MAX,
  DRAWER_REASON_MAX,
  drawerSellProblem,
  drawerTally,
  saleCountsInDrawer,
  type DrawerSyncState,
  type DrawerTally,
  type LocalDrawerMovement,
  type LocalDrawerSession,
  type TallySale,
} from '../drawer/cashDrawer';
import { money } from '../sale/money';
import { initDatabase, json, jsonOrNull, num, rows, str, strOrNull, withDb, type BatchCommand, type Conn, type Row } from './database';
import { emitLocalStoreEvent } from './events';
import { Mutex } from './mutex';
import { APP_VERSION, blockReason, compareVersions, offlineWarning, UNKNOWN_MIN_VERSION } from './policy';

const counterLock = new Mutex();

const META_REVOKED = 'revoked';
const META_UPDATE_REQUIRED = 'update_required';
const META_APPROVERS_VERSION = 'approvers_version';
// The `bootstrap_version` of the last bootstrap saved (real-time `versions.terminal`); absent = unknown.
const META_BOOTSTRAP_VERSION = 'bootstrap_version';
// Brand cache (src/ui/brandSource.ts): one row per cashier + one per logo checksum, in the key/value meta table.
const META_CASHIER_BRAND = 'cashierbrand:';
const META_BRAND_LOGO = 'brandlogo:';
// Receipt logo (src/sale/receiptAssets.ts): one row, keyed by the logo's checksum.
const META_RECEIPT_LOGO = 'receiptlogo:';
// License lease (src/license/, contract "License lease"): the record (JSON LicenseRecord) and, separately, the floor
// for "now" (last trusted server time, epoch ms) — raised by judgeLicense, set from a fresh lease by the license module.
const META_LICENSE = 'license';
const META_LICENSE_FLOOR = 'license_floor_ms';
// Device time (ISO) of the last successful server contact — the "not checked in for N h" banner.
const META_LAST_CHECK_IN = 'last_check_in_at';

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
    payload: json<SyncOp['payload']>(r.payload_json),
    signature: str(r.signature),
  };
}

function drawerSessionFromRow(r: Row): LocalDrawerSession {
  const closedById = r.closed_by_user_id;
  return {
    client_uuid: str(r.client_uuid),
    device_id: num(r.device_id),
    pos_terminal_id: num(r.pos_terminal_id),
    terminal_name: str(r.terminal_name),
    opened_at: str(r.opened_at),
    opened_by: { id: num(r.opened_by_user_id), name: str(r.opened_by_name) },
    opening_float: str(r.opening_float),
    status: str(r.status) as LocalDrawerSession['status'],
    sync_status: str(r.sync_status) as DrawerSyncState,
    closed_at: strOrNull(r.closed_at),
    closed_by: closedById === null || closedById === undefined ? null : { id: num(closedById), name: strOrNull(r.closed_by_name) ?? '' },
    counted_cash: strOrNull(r.counted_cash),
    expected_cash: strOrNull(r.expected_cash),
    close_note: strOrNull(r.close_note),
    close_sync_status: strOrNull(r.close_sync_status) as DrawerSyncState | null,
  };
}

function drawerMovementFromRow(r: Row): LocalDrawerMovement {
  return {
    client_uuid: str(r.client_uuid),
    session_client_uuid: str(r.session_client_uuid),
    kind: str(r.kind) as DrawerMovementKind,
    amount: str(r.amount),
    reason: str(r.reason),
    user: { id: num(r.user_id), name: str(r.user_name) },
    occurred_at: str(r.occurred_at),
    sync_status: str(r.sync_status) as DrawerSyncState,
  };
}

/** A drawer amount as typed → "123.45", or an error. `allowZero`: the opening float and the count may be 0. */
function drawerAmount(value: string, what: string, allowZero: boolean): string {
  const t = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`Enter the ${what} as an amount with at most 2 decimals.`);
  const n = Number(t);
  if (!allowZero && !(n > 0)) throw new Error(`The ${what} must be more than zero.`);
  if (n > DRAWER_MAX_AMOUNT) throw new Error(`The ${what} is too large.`);
  return money(n);
}

/** The receipt snapshot's payment methods (sales.receipt_json — src/sale/receipt.ts), read defensively. */
function snapshotMethodsOf(raw: unknown): PosPaymentMethod[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const m = (JSON.parse(raw) as { paymentMethods?: unknown }).paymentMethods;
    return Array.isArray(m) ? (m as PosPaymentMethod[]) : null;
  } catch {
    return null;
  }
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

async function readOpenDrawer(conn: Conn): Promise<LocalDrawerSession | null> {
  const r = rows(await conn.execute(`SELECT * FROM cash_drawer_sessions WHERE status = 'OPEN' LIMIT 1`))[0];
  return r ? drawerSessionFromRow(r) : null;
}

/** The terminal's payment methods (bootstrap, else the catalog) — which payments are CASH. */
async function readKnownMethods(conn: Conn): Promise<PosPaymentMethod[]> {
  const b = await readBootstrap(conn);
  if (b?.payment_methods?.length) return b.payment_methods;
  if (catalogMemo) return catalogMemo.payment_methods ?? [];
  const r = rows(await conn.execute('SELECT json FROM catalog_cache WHERE id = 1'))[0];
  return r ? (json<PosCatalog>(r.json).payment_methods ?? []) : [];
}

/** The drawer figures for `session` over [opened_at, untilIso) (src/drawer/cashDrawer.ts drawerTally). */
async function readDrawerTally(conn: Conn, session: LocalDrawerSession, untilIso: string): Promise<DrawerTally> {
  const from = session.opened_at;
  // sold_at / refunded_at / opened_at are all Date.toISOString() — string order is time order.
  const saleRows = rows(
    await conn.execute(
      `SELECT payload_json, receipt_json, sync_status, voided_at, void_sync_status FROM sales WHERE sold_at >= ? AND sold_at < ?`,
      [from, untilIso],
    ),
  );
  const sales: TallySale[] = saleRows
    .filter((r) =>
      saleCountsInDrawer({ sync_status: str(r.sync_status), voided_at: strOrNull(r.voided_at), void_sync_status: strOrNull(r.void_sync_status) }),
    )
    .map((r) => ({ payload: json<SalePayload>(r.payload_json), snapshotMethods: snapshotMethodsOf(r.receipt_json) }));
  const refundRows = rows(
    await conn.execute(
      `SELECT s.payload_json, s.receipt_json FROM local_refunds r LEFT JOIN sales s ON s.client_uuid = r.sale_client_uuid
        WHERE r.refunded_at >= ? AND r.refunded_at < ?`,
      [from, untilIso],
    ),
  );
  const refunds = refundRows.map((r) => ({
    sale:
      r.payload_json === null || r.payload_json === undefined
        ? null
        : { payload: json<SalePayload>(r.payload_json), snapshotMethods: snapshotMethodsOf(r.receipt_json) },
  }));
  const movements = rows(
    await conn.execute('SELECT kind, amount FROM cash_drawer_movements WHERE session_client_uuid = ?', [session.client_uuid]),
  ).map((r) => ({ kind: str(r.kind) as DrawerMovementKind, amount: str(r.amount) }));
  return drawerTally({
    openingFloat: session.opening_float,
    sales,
    refunds,
    movements,
    knownMethods: await readKnownMethods(conn),
  });
}

// ---- license lease ------------------------------------------------------------------------------------------------

async function readLicenseRecord(conn: Conn): Promise<LicenseRecord> {
  const raw = await readMeta(conn, META_LICENSE);
  if (!raw) return { ...EMPTY_LICENSE_RECORD };
  try {
    const v = JSON.parse(raw) as Partial<LicenseRecord>;
    return {
      v: 1,
      seen: v.seen === true,
      locked: v.locked === true,
      lease: typeof v.lease === 'string' && v.lease ? v.lease : null,
      last: v.last && typeof v.last === 'object' ? v.last : null,
    };
  } catch {
    // Unreadable → as if a lease had been received but none is usable: never silently drop enforcement.
    return { ...EMPTY_LICENSE_RECORD, seen: true };
  }
}

async function writeLicenseRecord(tx: { execute: Conn['execute'] }, rec: LicenseRecord): Promise<void> {
  await tx.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_LICENSE, JSON.stringify(rec)]);
}

async function readLicenseFloor(conn: Conn): Promise<number> {
  const n = Number(await readMeta(conn, META_LICENSE_FLOOR));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function leaseIdsOf(enrollment: EnrollmentState | null, terminal: PosTerminalInfo | null): LeaseIds | null {
  if (!enrollment || !terminal) return null;
  return { deviceId: enrollment.device_id, terminalId: terminal.id, companyId: terminal.company.id };
}

/** (Re-)enrollment: the stored lease belongs to the old device id — drop it (and the lock: the new device's first
 * token / heartbeat says again). `seen` stays: once a server has issued leases, a fresh enrollment is enforced too
 * (its device token response carries a lease at once). The clock floor is kept. */
async function resetLicenseForEnrollment(tx: { execute: Conn['execute'] }): Promise<void> {
  const r = rows(await tx.execute('SELECT value FROM meta WHERE key = ?', [META_LICENSE]))[0];
  if (!r) return;
  let seen = true;
  try {
    seen = (JSON.parse(str(r.value)) as { seen?: unknown }).seen === true;
  } catch {
    // unreadable → keep enforcing
  }
  await writeLicenseRecord(tx, { ...EMPTY_LICENSE_RECORD, seen });
}

/** The stored lease judged now (src/license/licenseEval.ts); raises the persisted floor in ≥ 1-minute steps. */
async function judgeLicense(conn: Conn): Promise<{ record: LicenseRecord; evaluation: LicenseEvaluation; nowMs: number }> {
  const record = await readLicenseRecord(conn);
  const floorMs = await readLicenseFloor(conn);
  const bootstrap = await readBootstrap(conn);
  const enrollment = await readEnrollment(conn);
  const ids = leaseIdsOf(enrollment, bootstrap?.terminal ?? enrollment?.terminal ?? null);
  const { evaluation, nowMs } = await evaluateStoredLicense(record, floorMs, ids, bootstrap?.license_public_keys);
  if (nowMs >= floorMs + FLOOR_PERSIST_STEP_MS) {
    // Only ever raised here (a concurrent lowering from a fresh lease wins if it lands first).
    await conn.execute(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
      [META_LICENSE_FLOOR, String(Math.floor(nowMs))],
    );
  }
  return { record, evaluation, nowMs };
}

/** Everything a drawer op needs from the DB before it is signed. */
async function readDrawerPre(conn: Conn) {
  return {
    enrollment: await readEnrollment(conn),
    terminal: await readTerminal(conn),
    revoked: (await readMeta(conn, META_REVOKED)) === '1',
    open: await readOpenDrawer(conn),
  };
}

async function insertOutboxOp(
  tx: { execute: Conn['execute'] },
  op: { clientUuid: string; type: SyncOp['type']; createdAt: string; payloadJson: string; signature: string; deviceId: number },
): Promise<void> {
  await tx.execute(
    `INSERT INTO outbox (client_uuid, type, created_at, payload_json, signature, device_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    [op.clientUuid, op.type, op.createdAt, op.payloadJson, op.signature, op.deviceId],
  );
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
  /** Why selling is blocked (revoked / update / subscription locked / license / offline limits), computed from the
   * DB — or null. */
  sellingBlockedReason(): Promise<string | null>;
  /** The license record + the stored lease judged now (src/license/). */
  licenseStatus(): Promise<{ record: LicenseRecord; evaluation: LicenseEvaluation; nowMs: number }>;
  getLicenseRecord(): Promise<LicenseRecord>;
  /** Replace the license record; `floorMs` (when given) sets the clock floor unconditionally — only from a fresh,
   * verified lease's issued_at (src/license/license.ts). */
  saveLicenseRecord(rec: LicenseRecord, floorMs?: number): Promise<void>;
  /** Device time of the last successful server contact (persisted; the "not checked in" banner). */
  getLastCheckInAt(): Promise<string | null>;
  setLastCheckInAt(iso: string): Promise<void>;
  /** The non-blocking "not checked in for N h" banner text (pos-offline-unlimited.md A3), or null. */
  offlineWarning(): Promise<string | null>;
  /** Number of REJECTED ops. */
  rejectedCount(): Promise<number>;
  /** The cached catalog's version, without loading the whole catalog. */
  getCatalogVersion(): Promise<string | null>;
  /** The server's approvers version (real-time channel) the cached approver lists match; null = unknown. */
  getApproversVersion(): Promise<string | null>;
  setApproversVersion(version: string | null): Promise<void>;
  /** The `bootstrap_version` of the cached bootstrap (real-time `versions.terminal`); null = unknown (none cached, or
   * the server didn't send one). Written by `saveBootstrap`. */
  getBootstrapVersion(): Promise<string | null>;

  // ---- cash drawer (src/drawer/cashDrawer.ts; CLAUDE.md "Cash drawer"). Each write saves its row AND enqueues its
  // signed DRAWER_* op in ONE transaction, under counterLock (so no sale is recorded mid-open/close).
  /** The drawer session open on this device (any terminal), or null. */
  getOpenDrawerSession(): Promise<LocalDrawerSession | null>;
  /** Sessions closed on this Manila business date, newest first. */
  listClosedDrawerSessions(businessDate: string): Promise<LocalDrawerSession[]>;
  listDrawerMovements(sessionUuid: string): Promise<LocalDrawerMovement[]>;
  /** The session's figures up to now (open) or its close time (closed). */
  getDrawerTally(sessionUuid: string): Promise<DrawerTally>;
  openDrawer(input: { cashierUserId: number; cashierName: string; openingFloat: string }): Promise<LocalDrawerSession>;
  recordDrawerMovement(input: {
    sessionUuid: string;
    cashierUserId: number;
    cashierName: string;
    kind: DrawerMovementKind;
    amount: string;
    reason: string;
  }): Promise<LocalDrawerMovement>;
  /** Blind close: `device_expected_cash` is computed here at closed_at (never shown before the count is saved). */
  closeDrawer(input: {
    sessionUuid: string;
    cashierUserId: number;
    cashierName: string;
    countedCash: string;
    note: string | null;
  }): Promise<{ session: LocalDrawerSession; tally: DrawerTally }>;
  /** Remember a refund this device made (after POST /pos/refunds recorded it) — for the drawer's expected cash. */
  recordLocalRefund(input: { clientUuid: string; saleClientUuid: string | null; invoiceNumber: string | null; refundedAt: string }): Promise<void>;
}

/** `bootstrap_version` from a bootstrap response, read defensively (older servers don't send it). */
function bootstrapVersionOf(b: PosBootstrap): string | null {
  const v = (b as { bootstrap_version?: unknown }).bootstrap_version;
  return typeof v === 'string' && v !== '' ? v : null;
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
          await tx.execute('DELETE FROM meta WHERE key IN (?, ?, ?, ?)', [
            META_REVOKED,
            META_UPDATE_REQUIRED,
            META_APPROVERS_VERSION,
            META_BOOTSTRAP_VERSION,
          ]);
          await resetLicenseForEnrollment(tx);
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
          await tx.execute('DELETE FROM meta WHERE key IN (?, ?, ?, ?)', [
            META_REVOKED,
            META_UPDATE_REQUIRED,
            META_APPROVERS_VERSION,
            META_BOOTSTRAP_VERSION,
          ]);
          await resetLicenseForEnrollment(tx);
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
    const version = bootstrapVersionOf(b);
    // The cache and the version it matches are replaced together (the real-time hello reports that version).
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        await tx.execute('INSERT OR REPLACE INTO bootstrap_cache (id, json, saved_at) VALUES (1, ?, ?)', [
          JSON.stringify(b),
          new Date().toISOString(),
        ]);
        if (version === null) await tx.execute('DELETE FROM meta WHERE key = ?', [META_BOOTSTRAP_VERSION]);
        else await tx.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_BOOTSTRAP_VERSION, version]);
      }),
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

  getApproversVersion() {
    return withDb((conn) => readMeta(conn, META_APPROVERS_VERSION));
  },

  getBootstrapVersion() {
    return withDb((conn) => readMeta(conn, META_BOOTSTRAP_VERSION));
  },

  async setApproversVersion(version) {
    await withDb((conn) =>
      version === null
        ? conn.execute('DELETE FROM meta WHERE key = ?', [META_APPROVERS_VERSION])
        : conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_APPROVERS_VERSION, version]),
    );
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
        drawer: await readOpenDrawer(conn),
        license: (await judgeLicense(conn)).evaluation.code,
      }));
      if (!pre.enrollment || !pre.counters || !pre.terminal) throw new Error('This device is not enrolled.');
      const blocked =
        blockReason({
          revoked: pre.revoked,
          updateRequired: pre.updateRequired,
          terminal: pre.terminal,
          pendingOldestAt: pre.pending.oldestAt,
          pendingSales: pre.pending.offlineSales,
          license: pre.license,
        }) ?? drawerSellProblem(pre.drawer, pre.terminal.id);
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
          const type = str(op.type) as SyncOp['type'];
          if (type === 'SALE') {
            await tx.execute('UPDATE sales SET sync_status = ?, sync_result_json = ? WHERE client_uuid = ?', [
              state,
              JSON.stringify(result),
              result.client_uuid,
            ]);
          } else if (type === 'VOID') {
            await tx.execute('UPDATE sales SET void_sync_status = ? WHERE void_client_uuid = ?', [state, result.client_uuid]);
          } else if (type === 'DRAWER_OPEN') {
            await tx.execute('UPDATE cash_drawer_sessions SET sync_status = ? WHERE client_uuid = ?', [state, result.client_uuid]);
          } else if (type === 'DRAWER_MOVEMENT') {
            await tx.execute('UPDATE cash_drawer_movements SET sync_status = ? WHERE client_uuid = ?', [state, result.client_uuid]);
          } else if (type === 'DRAWER_CLOSE') {
            await tx.execute('UPDATE cash_drawer_sessions SET close_sync_status = ? WHERE close_client_uuid = ?', [
              state,
              result.client_uuid,
            ]);
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

  // ---------------------------------------------------------------- cash drawer

  getOpenDrawerSession() {
    return withDb(readOpenDrawer);
  },

  listClosedDrawerSessions(date) {
    return withDb(async (conn) =>
      rows(
        await conn.execute(
          `SELECT * FROM cash_drawer_sessions WHERE status = 'CLOSED' AND closed_business_date = ? ORDER BY closed_at DESC`,
          [date],
        ),
      ).map(drawerSessionFromRow),
    );
  },

  listDrawerMovements(sessionUuid) {
    return withDb(async (conn) =>
      rows(
        await conn.execute('SELECT * FROM cash_drawer_movements WHERE session_client_uuid = ? ORDER BY occurred_at, created_at', [
          sessionUuid,
        ]),
      ).map(drawerMovementFromRow),
    );
  },

  getDrawerTally(sessionUuid) {
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT * FROM cash_drawer_sessions WHERE client_uuid = ?', [sessionUuid]))[0];
      if (!r) throw new Error('Cash drawer session not found on this device.');
      const session = drawerSessionFromRow(r);
      return readDrawerTally(conn, session, session.closed_at ?? new Date().toISOString());
    });
  },

  openDrawer(input) {
    return counterLock.run(async () => {
      const openingFloat = drawerAmount(input.openingFloat, 'opening float', true);
      const pre = await withDb(readDrawerPre);
      if (!pre.enrollment || !pre.terminal) throw new Error('This device is not enrolled.');
      if (pre.revoked) throw new Error('This device has been revoked.');
      if (pre.open) throw new Error('A cash drawer is already open on this device — close it first.');
      const openedAt = new Date().toISOString();
      const payload: DrawerOpenPayload = { cashier_user_id: input.cashierUserId, opened_at: openedAt, opening_float: openingFloat };
      const payloadJson = canonicalJson(payload);
      const signature = await jose.signOpPayload(payload);
      const clientUuid = Crypto.randomUUID();
      const deviceId = pre.enrollment.device_id;
      const terminal = pre.terminal;
      await withDb((conn) =>
        conn.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO cash_drawer_sessions (client_uuid, device_id, pos_terminal_id, terminal_name, opened_at, opened_by_user_id,
                                               opened_by_name, opening_float, status, sync_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 'PENDING', ?)`,
            [clientUuid, deviceId, terminal.id, terminal.name, openedAt, input.cashierUserId, input.cashierName, openingFloat, openedAt],
          );
          await insertOutboxOp(tx, { clientUuid, type: 'DRAWER_OPEN', createdAt: openedAt, payloadJson, signature, deviceId });
        }),
      );
      emitLocalStoreEvent('enqueued');
      return {
        client_uuid: clientUuid,
        device_id: deviceId,
        pos_terminal_id: terminal.id,
        terminal_name: terminal.name,
        opened_at: openedAt,
        opened_by: { id: input.cashierUserId, name: input.cashierName },
        opening_float: openingFloat,
        status: 'OPEN',
        sync_status: 'PENDING',
        closed_at: null,
        closed_by: null,
        counted_cash: null,
        expected_cash: null,
        close_note: null,
        close_sync_status: null,
      } satisfies LocalDrawerSession;
    });
  },

  recordDrawerMovement(input) {
    return counterLock.run(async () => {
      const amount = drawerAmount(input.amount, 'amount', false);
      const reason = input.reason.trim();
      if (!reason) throw new Error('Enter the reason.');
      if (reason.length > DRAWER_REASON_MAX) throw new Error(`The reason must be ${DRAWER_REASON_MAX} characters or fewer.`);
      const pre = await withDb(readDrawerPre);
      if (!pre.enrollment) throw new Error('This device is not enrolled.');
      if (pre.revoked) throw new Error('This device has been revoked.');
      if (!pre.open || pre.open.client_uuid !== input.sessionUuid) throw new Error('This cash drawer is no longer open.');
      const occurredAt = new Date().toISOString();
      const payload: DrawerMovementPayload = {
        cashier_user_id: input.cashierUserId,
        session_client_uuid: input.sessionUuid,
        kind: input.kind,
        amount,
        reason,
        occurred_at: occurredAt,
      };
      const payloadJson = canonicalJson(payload);
      const signature = await jose.signOpPayload(payload);
      const clientUuid = Crypto.randomUUID();
      const deviceId = pre.enrollment.device_id;
      await withDb((conn) =>
        conn.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO cash_drawer_movements (client_uuid, session_client_uuid, kind, amount, reason, user_id, user_name, occurred_at,
                                                sync_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
            [clientUuid, input.sessionUuid, input.kind, amount, reason, input.cashierUserId, input.cashierName, occurredAt, occurredAt],
          );
          await insertOutboxOp(tx, { clientUuid, type: 'DRAWER_MOVEMENT', createdAt: occurredAt, payloadJson, signature, deviceId });
        }),
      );
      emitLocalStoreEvent('enqueued');
      return {
        client_uuid: clientUuid,
        session_client_uuid: input.sessionUuid,
        kind: input.kind,
        amount,
        reason,
        user: { id: input.cashierUserId, name: input.cashierName },
        occurred_at: occurredAt,
        sync_status: 'PENDING',
      } satisfies LocalDrawerMovement;
    });
  },

  closeDrawer(input) {
    // Under counterLock: no sale can be recorded between computing the expected cash and closing the session.
    return counterLock.run(async () => {
      const countedCash = drawerAmount(input.countedCash, 'counted cash', true);
      const note = input.note?.trim() || null;
      if (note && note.length > DRAWER_NOTE_MAX) throw new Error(`The note must be ${DRAWER_NOTE_MAX} characters or fewer.`);
      const closedAt = new Date().toISOString();
      const pre = await withDb(async (conn) => {
        const p = await readDrawerPre(conn);
        const tally = p.open && p.open.client_uuid === input.sessionUuid ? await readDrawerTally(conn, p.open, closedAt) : null;
        return { ...p, tally };
      });
      if (!pre.enrollment) throw new Error('This device is not enrolled.');
      if (pre.revoked) throw new Error('This device has been revoked.');
      if (!pre.open || !pre.tally || pre.open.client_uuid !== input.sessionUuid) throw new Error('This cash drawer is no longer open.');
      const expectedCash = money(pre.tally.expected);
      const payload: DrawerClosePayload = {
        cashier_user_id: input.cashierUserId,
        session_client_uuid: input.sessionUuid,
        closed_at: closedAt,
        counted_cash: countedCash,
        device_expected_cash: expectedCash,
        note,
      };
      const payloadJson = canonicalJson(payload);
      const signature = await jose.signOpPayload(payload);
      const clientUuid = Crypto.randomUUID();
      const deviceId = pre.enrollment.device_id;
      await withDb((conn) =>
        conn.transaction(async (tx) => {
          const upd = await tx.execute(
            `UPDATE cash_drawer_sessions
                SET status = 'CLOSED', closed_at = ?, closed_business_date = ?, closed_by_user_id = ?, closed_by_name = ?,
                    counted_cash = ?, expected_cash = ?, close_note = ?, close_client_uuid = ?, close_sync_status = 'PENDING'
              WHERE client_uuid = ? AND status = 'OPEN'`,
            [
              closedAt,
              businessDate(new Date(closedAt)),
              input.cashierUserId,
              input.cashierName,
              countedCash,
              expectedCash,
              note,
              clientUuid,
              input.sessionUuid,
            ],
          );
          if (upd.rowsAffected !== 1) throw new Error('This cash drawer is no longer open.');
          await insertOutboxOp(tx, { clientUuid, type: 'DRAWER_CLOSE', createdAt: closedAt, payloadJson, signature, deviceId });
        }),
      );
      emitLocalStoreEvent('enqueued');
      const session: LocalDrawerSession = {
        ...pre.open,
        status: 'CLOSED',
        closed_at: closedAt,
        closed_by: { id: input.cashierUserId, name: input.cashierName },
        counted_cash: countedCash,
        expected_cash: expectedCash,
        close_note: note,
        close_sync_status: 'PENDING',
      };
      return { session, tally: pre.tally };
    });
  },

  async recordLocalRefund(input) {
    await withDb(async (conn) => {
      // The refunded sale's own row, when it was rung up here: by client_uuid, else by its printed invoice number.
      let saleUuid = input.saleClientUuid;
      if (!saleUuid && input.invoiceNumber) {
        const r = rows(await conn.execute('SELECT client_uuid FROM sales WHERE invoice_number = ? LIMIT 1', [input.invoiceNumber.trim()]))[0];
        saleUuid = r ? str(r.client_uuid) : null;
      }
      await conn.execute(
        'INSERT OR IGNORE INTO local_refunds (client_uuid, sale_client_uuid, invoice_number, refunded_at, created_at) VALUES (?, ?, ?, ?, ?)',
        [input.clientUuid, saleUuid, input.invoiceNumber, input.refundedAt, new Date().toISOString()],
      );
    });
    emitLocalStoreEvent('changed');
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
        license: (await judgeLicense(conn)).evaluation.code,
      });
    });
  },

  licenseStatus() {
    return withDb(judgeLicense);
  },

  getLicenseRecord() {
    return withDb(readLicenseRecord);
  },

  async saveLicenseRecord(rec, floorMs) {
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        await writeLicenseRecord(tx, rec);
        if (floorMs !== undefined && Number.isFinite(floorMs) && floorMs > 0) {
          await tx.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_LICENSE_FLOOR, String(Math.floor(floorMs))]);
        }
      }),
    );
    emitLocalStoreEvent('changed');
  },

  getLastCheckInAt() {
    return withDb((conn) => readMeta(conn, META_LAST_CHECK_IN));
  },

  async setLastCheckInAt(iso) {
    await withDb((conn) => conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_LAST_CHECK_IN, iso]));
  },

  offlineWarning() {
    return withDb(async (conn) => {
      const pending = await readPending(conn);
      return offlineWarning({
        terminal: await readTerminal(conn),
        pendingOldestAt: pending.oldestAt,
        pendingSales: pending.offlineSales,
        lastCheckInAt: await readMeta(conn, META_LAST_CHECK_IN),
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

  // ---------------------------------------------------------------- brand cache (src/ui/brandSource.ts)

  getCashierBrand(userId) {
    return withDb(async (conn) => {
      const raw = await readMeta(conn, META_CASHIER_BRAND + userId);
      if (!raw) return null;
      try {
        const b = JSON.parse(raw) as PosBrand;
        return b && typeof b === 'object' && 'primary_color' in b ? b : null;
      } catch {
        return null;
      }
    });
  },

  async saveCashierBrand(userId, brand) {
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        await tx.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [META_CASHIER_BRAND + userId, JSON.stringify(brand)]);
        // Drop logos no cached cashier brand refers to any more (a brand's logo was replaced, or nobody uses it).
        const used = new Set<string>();
        const brands = rows(await tx.execute('SELECT value FROM meta WHERE substr(key, 1, ?) = ?', [META_CASHIER_BRAND.length, META_CASHIER_BRAND]));
        for (const r of brands) {
          try {
            const c = (JSON.parse(str(r.value)) as PosBrand).logo_checksum;
            if (c) used.add(c);
          } catch {
            // unreadable row: ignore
          }
        }
        const logos = rows(await tx.execute('SELECT key FROM meta WHERE substr(key, 1, ?) = ?', [META_BRAND_LOGO.length, META_BRAND_LOGO]));
        for (const r of logos) {
          const key = str(r.key);
          if (!used.has(key.slice(META_BRAND_LOGO.length))) await tx.execute('DELETE FROM meta WHERE key = ?', [key]);
        }
      }),
    );
  },

  getBrandLogo(checksum) {
    return withDb(async (conn) => {
      const raw = await readMeta(conn, META_BRAND_LOGO + checksum);
      if (!raw) return null;
      try {
        const img = JSON.parse(raw) as PosDisplayImage;
        return img && typeof img.data_base64 === 'string' && img.data_base64 !== '' ? img : null;
      } catch {
        return null;
      }
    });
  },

  async saveBrandLogo(checksum, image) {
    await withDb((conn) =>
      conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
        META_BRAND_LOGO + checksum,
        JSON.stringify({ content_type: image.content_type, data_base64: image.data_base64 }),
      ]),
    );
  },

  getReceiptLogo(checksum) {
    return withDb(async (conn) => {
      const raw = await readMeta(conn, META_RECEIPT_LOGO + checksum);
      if (!raw) return null;
      try {
        const img = JSON.parse(raw) as PosDisplayImage;
        return img && typeof img.data_base64 === 'string' && img.data_base64 !== '' ? img : null;
      } catch {
        return null;
      }
    });
  },

  async saveReceiptLogo(checksum, image) {
    await withDb((conn) =>
      conn.transaction(async (tx) => {
        await tx.execute('DELETE FROM meta WHERE substr(key, 1, ?) = ?', [META_RECEIPT_LOGO.length, META_RECEIPT_LOGO]);
        await tx.execute('INSERT INTO meta (key, value) VALUES (?, ?)', [
          META_RECEIPT_LOGO + checksum,
          JSON.stringify({ content_type: image.content_type, data_base64: image.data_base64 }),
        ]);
      }),
    );
  },

  getReceiptSnapshot(clientUuid) {
    return withDb(async (conn) => {
      const r = rows(await conn.execute('SELECT receipt_json FROM sales WHERE client_uuid = ?', [clientUuid]))[0];
      return r && r.receipt_json != null ? str(r.receipt_json) : null;
    });
  },

  async saveReceiptSnapshot(clientUuid, json) {
    await withDb((conn) => conn.execute('UPDATE sales SET receipt_json = ? WHERE client_uuid = ?', [json, clientUuid]));
  },
};
