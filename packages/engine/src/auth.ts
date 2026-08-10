import type { Database } from "bun:sqlite";
import type { User } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";

// Argon2id hashing via Bun's built-in Bun.password — no extra dependency.
// Plaintext passwords are never stored or logged; any log line that touches
// a credential goes through maskSecret first.

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export class AuthStore {
  constructor(private readonly db: Database = getDb()) {}

  count(): number {
    const row = this.db.query("SELECT COUNT(*) as n FROM users").get() as { n: number };
    return row.n;
  }

  listUsers(): User[] {
    const rows = this.db.query("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    return rows.map(toUser);
  }

  async addUser(username: string, password: string): Promise<User> {
    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const createdAt = Date.now();
    this.db
      .query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, username, passwordHash, createdAt);
    console.log(`[auth] created user "${username}" (password ${maskSecret(password)})`);
    return { id, username, createdAt };
  }

  removeUser(id: string): void {
    this.db.query("DELETE FROM users WHERE id = ?").run(id);
  }

  async verify(username: string, password: string): Promise<User | null> {
    const row = this.db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.password_hash);
    return ok ? toUser(row) : null;
  }

  // Bootstraps a single admin account from env vars on first boot, if the
  // users table is otherwise empty. Docker-friendly: ADMIN_USERNAME /
  // ADMIN_PASSWORD come from the container's env, never from a file this
  // agent would read.
  async seedFromEnvIfEmpty(): Promise<void> {
    if (this.count() > 0) return;

    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    if (!username || !password) {
      console.warn(
        "[auth] no users exist and ADMIN_USERNAME/ADMIN_PASSWORD are unset — no login will be possible until one is created."
      );
      return;
    }

    await this.addUser(username, password);
  }
}
