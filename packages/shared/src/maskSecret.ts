// Shared secret-obfuscation helper — CLAUDE.md "Secret obfuscation".
// Use at every log call and every API response that echoes configuration
// back (webhook URLs, tokens, passwords). Never render a full secret.
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const visible = 4;
  if (value.length <= visible) return "•".repeat(value.length);
  return "•".repeat(value.length - visible) + value.slice(-visible);
}
