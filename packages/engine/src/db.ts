import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One gitignored SQLite file for everything the engine owns: sensors,
// latches, latch state, and user accounts. Replaces the config.json +
// flat JSON state snapshot originally described in SPEC.md section 6.
const DEFAULT_DB_PATH = "./data/app.db";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  const path = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
  mkdirSync(dirname(path), { recursive: true });

  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sensors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      discovered_metrics TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS latches (
      id TEXT PRIMARY KEY,
      sensor_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      direction TEXT NOT NULL,
      arm_threshold REAL NOT NULL,
      clear_threshold REAL NOT NULL,
      duration_seconds INTEGER NOT NULL,
      webhook_json TEXT NOT NULL,
      resolved_webhook_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS latch_state (
      latch_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'idle',
      armed_at INTEGER,
      fired_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

// Test-only escape hatch so each test file can start from a clean in-memory db.
export function resetDbForTests(database: Database): void {
  migrate(database);
}
