import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

// One gitignored SQLite file for everything the engine owns: sensors,
// latches, latch state, user accounts, and Protect console connections.
// Drizzle owns the schema (see schema.ts) and migrations (see
// drizzle/ — generated via `bun run db:generate`, applied here on boot).
const DEFAULT_DB_PATH = "./data/app.db";

// import.meta.dir (Bun-specific) breaks once Next.js's webpack bundles this
// module for a Route Handler — the bundle's on-disk location isn't this
// source file's, so a path relative to it resolves to nowhere. Resolve
// relative to process.cwd() instead, trying both real run contexts: `bun
// test` / `db:migrate` (cwd = repo root) and the Next app, dev or compiled,
// which Next always runs with cwd = apps/web (see DEPLOY.md).
function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_FOLDER) return process.env.MIGRATIONS_FOLDER;
  const candidates = [
    join(process.cwd(), "packages", "engine", "drizzle"), // cwd = repo root
    join(process.cwd(), "..", "..", "packages", "engine", "drizzle"), // cwd = apps/web
    join(process.cwd(), "drizzle"), // cwd = packages/engine
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

const MIGRATIONS_FOLDER = resolveMigrationsFolder();

let db: BunSQLiteDatabase<typeof schema> | null = null;

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (db) return db;

  const path = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");

  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

// Test-only escape hatch so each test file can start from a clean in-memory
// db with the schema applied, without going through migration files.
export function createTestDb(): BunSQLiteDatabase<typeof schema> {
  const sqlite = new Database(":memory:");
  const testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_FOLDER });
  return testDb;
}
