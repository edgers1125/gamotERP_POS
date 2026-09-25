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
];
