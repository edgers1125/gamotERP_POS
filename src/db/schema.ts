// Local schema of the POS app's encrypted SQLite database, as ordered migrations. A migration is applied once, in its
// own transaction together with its row in `schema_migrations`. NEVER edit a shipped migration — add a new one.
//
// Tables:
//   meta              key/value flags (revoked, app-update-required) — small things that must survive a restart
//   enrollment        the ONE enrollment of this device (id = 1)
//   counters          device-owned invoice/return sequence numbers (id = 1)
//   bootstrap_cache   last GET /pos/bootstrap (id = 1)
//   catalog_cache     last GET /pos/catalog as JSON + its version (id = 1)
//   catalog_items     one row per catalog item, for search by name / sku_code (indexed, lower-cased)
//   catalog_barcodes  barcode → sku_id (a SKU may have several; a barcode may map to several SKUs)
//   approvers         cached co-signer lists per approval kind (DISCOUNT / VOID / REFUND)
//   sales             every sale rung up on this device (signed payload, printed invoice number, sync + void state)
//   outbox            signed ops waiting for / done with POST /pos/sync — rows are never deleted
//   pin_verifiers     offline cashier PIN verifiers (salted hash only, produced by P-A4)
//   sales.receipt_json  (v2) what the receipt needs that the signed payload lacks — item names, VAT / Senior-PWD flags,
//                       customer name, payment method names — as sold (src/sale/receipt.ts ReceiptSnapshot), so a reprint
//                       after a restart matches the original even if the catalog changed since
//   cash_drawer_sessions / cash_drawer_movements  (v3) the till's cash drawer: open (float) → cash in/out → blind close;
//                       each write also enqueues its signed DRAWER_* outbox op (src/drawer/, CLAUDE.md "Cash drawer")
//   local_refunds       (v3) refunds made on this device, so the drawer's expected cash can subtract the cash paid back
//   attendance_punches / attendance_cache  (v4) attendance kiosk mode: the signed punch queue (+ photo files on disk)
//                       and the kiosk's cached config / employee list (src/attendance/, CLAUDE.md "Attendance kiosk mode")

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE meta (
         key   TEXT PRIMARY KEY NOT NULL,
         value TEXT NOT NULL
       )`,
      `CREATE TABLE enrollment (
         id            INTEGER PRIMARY KEY CHECK (id = 1),
         device_id     INTEGER NOT NULL,
         terminal_json TEXT NOT NULL,
         enrolled_at   TEXT NOT NULL
       )`,
      `CREATE TABLE counters (
         id                  INTEGER PRIMARY KEY CHECK (id = 1),
         next_invoice_number INTEGER NOT NULL CHECK (next_invoice_number >= 1),
         next_return_number  INTEGER NOT NULL CHECK (next_return_number >= 1),
         updated_at          TEXT NOT NULL
       )`,
      `CREATE TABLE bootstrap_cache (
         id       INTEGER PRIMARY KEY CHECK (id = 1),
         json     TEXT NOT NULL,
         saved_at TEXT NOT NULL
       )`,
      `CREATE TABLE catalog_cache (
         id       INTEGER PRIMARY KEY CHECK (id = 1),
         version  TEXT NOT NULL,
         json     TEXT NOT NULL,
         saved_at TEXT NOT NULL
       )`,
      `CREATE TABLE catalog_items (
         sku_id      INTEGER PRIMARY KEY NOT NULL,
         position    INTEGER NOT NULL,
         sku_code    TEXT NOT NULL,
         sku_code_lc TEXT NOT NULL,
         final_name  TEXT NOT NULL,
         name_lc     TEXT NOT NULL,
         item_json   TEXT NOT NULL
       )`,
      `CREATE INDEX catalog_items_name_lc ON catalog_items (name_lc)`,
      `CREATE INDEX catalog_items_sku_code_lc ON catalog_items (sku_code_lc)`,
      `CREATE TABLE catalog_barcodes (
         barcode TEXT NOT NULL,
         sku_id  INTEGER NOT NULL,
         PRIMARY KEY (barcode, sku_id)
       )`,
      `CREATE TABLE approvers (
         kind      TEXT PRIMARY KEY NOT NULL CHECK (kind IN ('DISCOUNT', 'VOID', 'REFUND')),
         list_json TEXT NOT NULL,
         saved_at  TEXT NOT NULL
       )`,
      // device_id is part of the invoice uniqueness: a re-enrolled device (new device_id) continues from the server's
      // counters, which may overlap numbers an earlier enrollment used locally.
      `CREATE TABLE sales (
         client_uuid      TEXT PRIMARY KEY NOT NULL,
         device_id        INTEGER NOT NULL,
         invoice_seq      INTEGER NOT NULL,
         invoice_number   TEXT NOT NULL,
         business_date    TEXT NOT NULL,
         sold_at          TEXT NOT NULL,
         payload_json     TEXT NOT NULL,
         sync_status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'RECORDED', 'REJECTED')),
         sync_result_json TEXT,
         void_client_uuid TEXT UNIQUE,
         voided_at        TEXT,
         void_reason      TEXT,
         void_sync_status TEXT CHECK (void_sync_status IS NULL OR void_sync_status IN ('PENDING', 'RECORDED', 'REJECTED')),
         refunded         INTEGER NOT NULL DEFAULT 0,
         created_at       TEXT NOT NULL,
         UNIQUE (device_id, invoice_seq)
       )`,
      `CREATE INDEX sales_business_date ON sales (business_date, sold_at)`,
      `CREATE TABLE outbox (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         client_uuid     TEXT NOT NULL UNIQUE,
         type            TEXT NOT NULL CHECK (type IN ('SALE', 'VOID')),
         created_at      TEXT NOT NULL,
         payload_json    TEXT NOT NULL,
         signature       TEXT NOT NULL,
         device_id       INTEGER NOT NULL,
         status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'REJECTED')),
         attempts        INTEGER NOT NULL DEFAULT 0,
         last_error      TEXT,
         last_attempt_at TEXT,
         result_json     TEXT,
         done_at         TEXT
       )`,
      `CREATE INDEX outbox_status_id ON outbox (status, id)`,
      `CREATE TABLE pin_verifiers (
         user_id          INTEGER PRIMARY KEY NOT NULL,
         name             TEXT NOT NULL,
         email            TEXT NOT NULL,
         permissions_json TEXT NOT NULL,
         verifier         TEXT NOT NULL,
         updated_at       TEXT NOT NULL
       )`,
    ],
  },
  {
    version: 2,
    name: 'sales_receipt_snapshot',
    statements: ['ALTER TABLE sales ADD COLUMN receipt_json TEXT'],
  },
  {
    // Cash drawer sessions (GamotERP docs/plans/sales-side-tables-and-cash-drawer.md §B). SQLite can't change a CHECK,
    // so the outbox is rebuilt with the three new op types (rows, ids and the AUTOINCREMENT sequence are kept).
    version: 3,
    name: 'cash_drawer',
    statements: [
      `CREATE TABLE outbox_v3 (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         client_uuid     TEXT NOT NULL UNIQUE,
         type            TEXT NOT NULL CHECK (type IN ('SALE', 'VOID', 'DRAWER_OPEN', 'DRAWER_MOVEMENT', 'DRAWER_CLOSE')),
         created_at      TEXT NOT NULL,
         payload_json    TEXT NOT NULL,
         signature       TEXT NOT NULL,
         device_id       INTEGER NOT NULL,
         status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'REJECTED')),
         attempts        INTEGER NOT NULL DEFAULT 0,
         last_error      TEXT,
         last_attempt_at TEXT,
         result_json     TEXT,
         done_at         TEXT
       )`,
      `INSERT INTO outbox_v3 (id, client_uuid, type, created_at, payload_json, signature, device_id, status, attempts,
                             last_error, last_attempt_at, result_json, done_at)
       SELECT id, client_uuid, type, created_at, payload_json, signature, device_id, status, attempts,
              last_error, last_attempt_at, result_json, done_at
         FROM outbox`,
      'DROP TABLE outbox',
      'ALTER TABLE outbox_v3 RENAME TO outbox',
      'CREATE INDEX outbox_status_id ON outbox (status, id)',
      // One row per drawer session. client_uuid = its DRAWER_OPEN op; close_client_uuid = its DRAWER_CLOSE op. Money is
      // "123.45" text. expected_cash is what THIS device computed at close (the server computes its own).
      `CREATE TABLE cash_drawer_sessions (
         client_uuid          TEXT PRIMARY KEY NOT NULL,
         device_id            INTEGER NOT NULL,
         pos_terminal_id      INTEGER NOT NULL,
         terminal_name        TEXT NOT NULL,
         opened_at            TEXT NOT NULL,
         opened_by_user_id    INTEGER NOT NULL,
         opened_by_name       TEXT NOT NULL,
         opening_float        TEXT NOT NULL,
         status               TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
         sync_status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'RECORDED', 'REJECTED')),
         closed_at            TEXT,
         closed_business_date TEXT,
         closed_by_user_id    INTEGER,
         closed_by_name       TEXT,
         counted_cash         TEXT,
         expected_cash        TEXT,
         close_note           TEXT,
         close_client_uuid    TEXT UNIQUE,
         close_sync_status    TEXT CHECK (close_sync_status IS NULL OR close_sync_status IN ('PENDING', 'RECORDED', 'REJECTED')),
         created_at           TEXT NOT NULL,
         CHECK ((status = 'OPEN') = (closed_at IS NULL))
       )`,
      // One drawer open at a time on this device.
      `CREATE UNIQUE INDEX cash_drawer_sessions_one_open ON cash_drawer_sessions (status) WHERE status = 'OPEN'`,
      'CREATE INDEX cash_drawer_sessions_closed ON cash_drawer_sessions (closed_business_date, closed_at)',
      `CREATE TABLE cash_drawer_movements (
         client_uuid         TEXT PRIMARY KEY NOT NULL,
         session_client_uuid TEXT NOT NULL REFERENCES cash_drawer_sessions (client_uuid),
         kind                TEXT NOT NULL CHECK (kind IN ('CASH_IN', 'CASH_OUT')),
         amount              TEXT NOT NULL,
         reason              TEXT NOT NULL,
         user_id             INTEGER NOT NULL,
         user_name           TEXT NOT NULL,
         occurred_at         TEXT NOT NULL,
         sync_status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'RECORDED', 'REJECTED')),
         created_at          TEXT NOT NULL
       )`,
      'CREATE INDEX cash_drawer_movements_session ON cash_drawer_movements (session_client_uuid, occurred_at)',
      // Refunds this device made (online, POST /pos/refunds) — only so the drawer's expected cash can take the cash
      // paid back out. sale_client_uuid is set when the refunded sale was rung up on this device (its payments known).
      `CREATE TABLE local_refunds (
         client_uuid      TEXT PRIMARY KEY NOT NULL,
         sale_client_uuid TEXT,
         invoice_number   TEXT,
         refunded_at      TEXT NOT NULL,
         created_at       TEXT NOT NULL
       )`,
      'CREATE INDEX local_refunds_refunded_at ON local_refunds (refunded_at)',
    ],
  },
  {
    // Attendance kiosk mode (GamotERP docs/plans/hr-payroll-attendance.md; CLAUDE.md "Attendance kiosk mode").
    version: 4,
    name: 'attendance_kiosk',
    statements: [
      // Every punch made on this tablet, online or offline — its own queue (multipart upload to POST
      // /pos/attendance/punches, not /pos/sync), oldest first by seq, never deleted. payload_json is EXACTLY the signed
      // canonical text; frames_json lists the JPEG files (path, uri, sha256) — deleted from disk only once the server
      // RECORDED the punch (or answered DUPLICATE); frames_deleted_at says when. REJECTED rows (and their photos) stay
      // for a manager.
      `CREATE TABLE attendance_punches (
         seq               INTEGER PRIMARY KEY AUTOINCREMENT,
         client_uuid       TEXT NOT NULL UNIQUE,
         device_id         INTEGER NOT NULL,
         user_id           INTEGER NOT NULL,
         display_name      TEXT NOT NULL,
         kind              TEXT NOT NULL CHECK (kind IN ('IN', 'OUT')),
         device_time       TEXT NOT NULL,
         online            INTEGER NOT NULL CHECK (online IN (0, 1)),
         payload_json      TEXT NOT NULL,
         signature         TEXT NOT NULL,
         frames_json       TEXT NOT NULL,
         status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RECORDED', 'REJECTED')),
         attempts          INTEGER NOT NULL DEFAULT 0,
         last_error        TEXT,
         last_attempt_at   TEXT,
         result_json       TEXT,
         done_at           TEXT,
         frames_deleted_at TEXT,
         created_at        TEXT NOT NULL
       )`,
      'CREATE INDEX attendance_punches_status_seq ON attendance_punches (status, seq)',
      // The kiosk's last known state for THIS enrollment (device_id): on/off, GET /pos/attendance/kiosk and the cached
      // employee list (GET /pos/attendance/employees) — the kiosk works offline from these. No PIN data, ever.
      `CREATE TABLE attendance_cache (
         id             INTEGER PRIMARY KEY CHECK (id = 1),
         device_id      INTEGER NOT NULL,
         enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
         reason         TEXT,
         kiosk_json     TEXT,
         employees_json TEXT,
         checked_at     TEXT NOT NULL
       )`,
    ],
  },
];
