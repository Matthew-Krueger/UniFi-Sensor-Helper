import { z } from "zod";

// Shared client+server validation, via Zod schemas — CLAUDE.md's trust-
// boundary rule: never assume client-side validation actually ran, so
// every schema here runs server-side too (see apps/web/app/api/users/
// route.ts and apps/web/app/api/account/password/route.ts), not just for
// inline UI feedback. One schema per rule, not two hand-maintained copies.

export const usernameSchema = z
  .string()
  .min(3, "Username must be 3-32 characters")
  .max(32, "Username must be 3-32 characters")
  .regex(/^[A-Za-z0-9]+$/, "Username must be alphanumeric (letters and numbers only)");

// Any characters allowed (argon2 doesn't care about symbols), but require
// at least 2 of the 4 common character classes so "password" or
// "12345678" don't pass. Max length caps argon2 hashing cost on
// arbitrarily large input — a length limit, not a strength rule.
export const passwordSchema = z
  .string()
  .min(8, "Password must be 8-128 characters")
  .max(128, "Password must be 8-128 characters")
  .refine((password) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
    return classes >= 2;
  }, "Password must include at least 2 of: lowercase, uppercase, numbers, symbols");

// Bounds-only checks (no format requirement) for fields that are still
// worth capping even though they're not security-sensitive the way
// username/password are — an unbounded string in a request body is a
// standing DoS/storage-bloat risk regardless of what the field is for.
export const consoleNameSchema = z.string().min(1).max(100, "Name must be 100 characters or fewer");
export const consoleHostSchema = z.string().min(1).max(255, "Host must be 255 characters or fewer");
export const consoleApiKeySchema = z.string().min(1).max(512, "API key must be 512 characters or fewer");

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Thin wrapper so callers (route handlers and form onChange handlers
// alike) don't need to know Zod's result shape — just valid/error.
function check(schema: z.ZodType<string>, value: string): ValidationResult {
  const result = schema.safeParse(value);
  return result.success ? { valid: true } : { valid: false, error: result.error.issues[0]?.message };
}

export function validateUsername(username: string): ValidationResult {
  return check(usernameSchema, username);
}

export function validatePassword(password: string): ValidationResult {
  return check(passwordSchema, password);
}
