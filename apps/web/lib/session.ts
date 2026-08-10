import { cookies } from "next/headers";

// Minimal signed-cookie session — no external session store, consistent
// with "no database beyond what's needed for latch persistence" (CLAUDE.md),
// now read as also covering auth. SESSION_SECRET is a pure secret, lives in
// .env only — never in the SQLite-backed config.
const COOKIE_NAME = "usl_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — required to sign session cookies");
  }
  return secret;
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(getSecret()), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(sig).toString("base64url");
}

export async function createSessionCookie(userId: string): Promise<void> {
  const payload = `${userId}.${Date.now()}`;
  const signature = await sign(payload);
  const store = await cookies();
  store.set(COOKIE_NAME, `${payload}.${signature}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [userId, timestamp, signature] = parts;
  const expected = await sign(`${userId}.${timestamp}`);
  if (expected !== signature) return null;

  return userId;
}
