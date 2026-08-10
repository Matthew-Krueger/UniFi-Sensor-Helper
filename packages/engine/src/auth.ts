import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { User } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";
import * as schema from "./schema";
import { users } from "./schema";

// Argon2id hashing via Bun's built-in Bun.password — no extra dependency.
// Plaintext passwords are never stored or logged; any log line that touches
// a credential goes through maskSecret first.

function toUser(row: typeof schema.users.$inferSelect): User {
  return { id: row.id, username: row.username, createdAt: row.createdAt };
}

export class AuthStore {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema> = getDb()) {}

  count(): number {
    return this.db.select().from(users).all().length;
  }

  listUsers(): User[] {
    return this.db.select().from(users).orderBy(users.createdAt).all().map(toUser);
  }

  async addUser(username: string, password: string): Promise<User> {
    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const createdAt = Date.now();
    this.db.insert(users).values({ id, username, passwordHash, createdAt }).run();
    console.log(`[auth] created user "${username}" (password ${maskSecret(password)})`);
    return { id, username, createdAt };
  }

  removeUser(id: string): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  async verify(username: string, password: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.passwordHash);
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
