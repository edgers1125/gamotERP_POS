// Opens the POS app's SQLCipher database and applies migrations. The encryption key is 32 random bytes generated
// once on first launch (expo-crypto) and kept in expo-secure-store (Android Keystore-backed) — it never leaves the
// device and is never derived from anything a user types. All SQL goes through `withDb`, which serialises access to
// the single connection (see mutex.ts for why).
//
// Expo Go preview (src/config/runtime.ts `isExpoGo`, CLAUDE.md "Expo Go preview mode"): Expo Go has no op-sqlite, so
// there — and ONLY there — an unencrypted expo-sqlite database with its own file name is opened instead
// (expoGoSqlite.ts). op-sqlite is therefore `require`d lazily on the real path, never imported at the top level.
import type * as OpSqlite from '@op-engineering/op-sqlite';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { isExpoGo } from '../config/runtime';
import { Mutex } from './mutex';
import { MIGRATIONS } from './schema';

const DB_NAME = 'gamoterp_pos.sqlite';
const KEY_STORE_NAME = 'gamoterp_pos_db_key_v1';
/** Expo Go preview only — a different file, so a later dev/release build never opens (or trusts) a plaintext DB. */
const EXPO_GO_PREVIEW_DB_NAME = 'gamoterp_pos_expo_go_preview_UNENCRYPTED.sqlite';

// ---- the connection API localStore uses: exactly this subset of op-sqlite's `DB` (op-sqlite's own types satisfy it;
// the Expo Go adapter implements it) -------------------------------------------------------------------------------

export type Scalar = OpSqlite.Scalar;
export type Row = Record<string, Scalar>;
export interface QueryResult {
  rows: Row[];
  rowsAffected: number;
  insertId?: number;
}
export interface Tx {
  execute(sql: string, params?: Scalar[]): Promise<QueryResult>;
}
/** [sql] | [sql, params] | [sql, list of params — the statement runs once per entry] (op-sqlite SQLBatchTuple). */
export type BatchCommand = OpSqlite.SQLBatchTuple;
export interface Conn {
  execute(sql: string, params?: Scalar[]): Promise<QueryResult>;
  /** Runs `fn` in one SQL transaction; rolls back and rethrows if it throws. */
  transaction(fn: (tx: Tx) => Promise<void>): Promise<void>;
  /** Every command in ONE transaction. */
  executeBatch(commands: BatchCommand[]): Promise<{ rowsAffected?: number }>;
  close(): void;
}

const dbLock = new Mutex();
let db: Conn | null = null;
let opening: Promise<void> | null = null;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

async function loadOrCreateKey(): Promise<{ key: string; created: boolean }> {
  const existing = await SecureStore.getItemAsync(KEY_STORE_NAME);
  if (existing) return { key: existing, created: false };
  const key = toHex(Crypto.getRandomBytes(32));
  await SecureStore.setItemAsync(KEY_STORE_NAME, key);
  // Read back: a key we can't retrieve later would make the database permanently unreadable.
  const stored = await SecureStore.getItemAsync(KEY_STORE_NAME);
  if (stored !== key) throw new Error('Could not store the local database key in secure storage.');
  return { key, created: true };
}

async function migrate(conn: Conn): Promise<void> {
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const res = await conn.execute('SELECT version FROM schema_migrations');
  const applied = new Set(res.rows.map((r) => Number(r.version)));
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    await conn.transaction(async (tx) => {
      for (const sql of m.statements) await tx.execute(sql);
      await tx.execute('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
    });
  }
}

async function openDatabase(): Promise<void> {
  if (isExpoGo) {
    db = await openExpoGoPreviewDatabase();
    return;
  }
  // Lazy: loading op-sqlite's JS touches its native module, which Expo Go doesn't have.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSQLCipher, open } = require('@op-engineering/op-sqlite') as typeof OpSqlite;
  if (!isSQLCipher()) {
    // package.json "op-sqlite": { "sqlcipher": true } must be in the native build — never fall back to plaintext.
    throw new Error('This build has no SQLCipher support; refusing to store sales unencrypted.');
  }
  const { key, created } = await loadOrCreateKey();
  const conn = open({ name: DB_NAME, encryptionKey: key });
  try {
    // First real read: fails with "file is not a database" when the key doesn't match the file.
    await conn.execute('SELECT count(*) AS n FROM sqlite_master');
  } catch (e) {
    conn.close();
    throw new Error(
      created
        ? 'The local database exists but its key was lost (secure storage was reset). The device must be reset and re-enrolled.'
        : `The local database could not be opened: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await conn.execute('PRAGMA journal_mode = WAL');
  // FULL: a committed sale (and its invoice number) survives a power cut, not just an app crash.
  await conn.execute('PRAGMA synchronous = FULL');
  await conn.execute('PRAGMA foreign_keys = ON');
  await migrate(conn);
  db = conn;
}

/** Expo Go preview: plaintext expo-sqlite, same pragmas (where they apply) and the same migrations. */
async function openExpoGoPreviewDatabase(): Promise<Conn> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { openExpoGoDatabase } = require('./expoGoSqlite') as typeof import('./expoGoSqlite');
  const conn = await openExpoGoDatabase(EXPO_GO_PREVIEW_DB_NAME);
  try {
    await conn.execute('PRAGMA journal_mode = WAL');
    await conn.execute('PRAGMA synchronous = FULL');
    await conn.execute('PRAGMA foreign_keys = ON');
    await migrate(conn);
  } catch (e) {
    conn.close();
    throw new Error(`The Expo Go preview database could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
  return conn;
}

/** Opens + migrates once; safe to call many times / concurrently. A failed open can be retried. */
export function initDatabase(): Promise<void> {
  if (db) return Promise.resolve();
  if (!opening) {
    opening = dbLock.run(openDatabase).catch((e) => {
      opening = null;
      throw e;
    });
  }
  return opening;
}

/** Runs `fn` with exclusive use of the connection (after init). Use `conn.transaction` inside for writes. */
export async function withDb<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  await initDatabase();
  return dbLock.run(() => fn(db!));
}

// ---- row helpers (op-sqlite returns Scalar values) --------------------------------------------------------------

export function rows(res: QueryResult): Row[] {
  return res.rows ?? [];
}

export function str(v: Scalar | undefined): string {
  if (v === null || v === undefined) throw new Error('Unexpected NULL in the local database');
  return String(v);
}

export function strOrNull(v: Scalar | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function num(v: Scalar | undefined): number {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) throw new Error('Unexpected non-number in the local database');
  return n;
}

export function json<T>(v: Scalar | undefined): T {
  return JSON.parse(str(v)) as T;
}

export function jsonOrNull<T>(v: Scalar | undefined): T | null {
  return v === null || v === undefined ? null : (JSON.parse(String(v)) as T);
}
