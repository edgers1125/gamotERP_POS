// EXPO GO PREVIEW ONLY (src/config/runtime.ts `isExpoGo`) — never loaded by a development or release build
// (database.ts `require`s this file only on the Expo Go path, and expo-sqlite is excluded from native autolinking in
// package.json, so a real build doesn't even contain it).
//
// Expo Go has no op-sqlite/SQLCipher, so the preview opens a PLAIN, UNENCRYPTED expo-sqlite database and wraps it in
// exactly the subset of op-sqlite's `DB` API that localStore uses (`Conn` in database.ts). Anyone with access to the
// phone's app data can read it: a preview for trying the app against a DEV backend, never a real till.
//
// Concurrency: database.ts already serialises ALL SQL on this connection through its mutex, so a transaction here is a
// plain BEGIN IMMEDIATE … COMMIT/ROLLBACK on the one connection (expo-sqlite's withTransactionAsync is the same thing
// minus IMMEDIATE; withExclusiveTransactionAsync would open a second connection, which we don't want).
import * as SQLite from 'expo-sqlite';

import type { BatchCommand, Conn, QueryResult, Scalar } from './database';

type Bind = string | number | boolean | null | Uint8Array;

function toBind(v: Scalar): Bind {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('Unsupported SQL parameter type');
}

async function run(db: SQLite.SQLiteDatabase, sql: string, params: Scalar[] = []): Promise<QueryResult> {
  const stmt = await db.prepareAsync(sql);
  try {
    const res = await stmt.executeAsync<Record<string, Scalar>>(params.map(toBind));
    const resultRows = await res.getAllAsync();
    return { rows: resultRows, rowsAffected: res.changes, insertId: res.lastInsertRowId };
  } finally {
    await stmt.finalizeAsync();
  }
}

/** One command of an op-sqlite style batch: no params, one param list, or a list of param lists (one run each). */
async function runBatchCommand(db: SQLite.SQLiteDatabase, cmd: BatchCommand): Promise<number> {
  const [sql, params] = cmd;
  if (!params || params.length === 0 || !Array.isArray(params[0])) {
    return (await run(db, sql, (params as Scalar[] | undefined) ?? [])).rowsAffected;
  }
  const stmt = await db.prepareAsync(sql);
  let affected = 0;
  try {
    for (const p of params as Scalar[][]) {
      const res = await stmt.executeAsync(p.map(toBind));
      affected += res.changes;
      await res.resetAsync();
    }
  } finally {
    await stmt.finalizeAsync();
  }
  return affected;
}

async function inTransaction<T>(db: SQLite.SQLiteDatabase, fn: () => Promise<T>): Promise<T> {
  await db.execAsync('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    try {
      await db.execAsync('ROLLBACK');
    } catch {
      // SQLite may already have rolled back (e.g. after SQLITE_FULL); the original error is what matters.
    }
    throw e;
  }
  await db.execAsync('COMMIT');
  return result;
}

/** Opens (creating if needed) the preview database file. */
export async function openExpoGoDatabase(name: string): Promise<Conn> {
  const db = await SQLite.openDatabaseAsync(name);
  const conn: Conn = {
    execute: (sql, params) => run(db, sql, params),
    transaction: (fn) => inTransaction(db, () => fn({ execute: (sql, params) => run(db, sql, params) })),
    executeBatch: (commands) =>
      inTransaction(db, async () => {
        let rowsAffected = 0;
        for (const cmd of commands) rowsAffected += await runBatchCommand(db, cmd);
        return { rowsAffected };
      }),
    close: () => {
      db.closeSync();
    },
  };
  return conn;
}
