import type { Latch, Role } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1, superadmin: 2 };

// Webhook URLs are only masked from the read-only "user" role — CLAUDE.md's
// obfuscation rule carves this out explicitly (see CLAUDE.md's "Secret
// obfuscation" section): admin/superadmin already have full operational
// access to rules (create/edit/delete/test), so seeing the real URL isn't
// a new capability, just a UI convenience (copy it, verify it, debug it).
export function redactLatch(latch: Latch, actorRole: Role) {
  if (ROLE_RANK[actorRole] >= ROLE_RANK.admin) return latch;
  return {
    ...latch,
    webhook: { ...latch.webhook, url: maskSecret(latch.webhook.url) },
    resolvedWebhook: latch.resolvedWebhook
      ? { ...latch.resolvedWebhook, url: maskSecret(latch.resolvedWebhook.url) }
      : undefined,
  };
}
