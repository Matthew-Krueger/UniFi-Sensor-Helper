import type { Latch, Role, WebhookTarget } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1, superadmin: 2 };

export function shouldMaskWebhookUrl(actorRole: Role): boolean {
  return ROLE_RANK[actorRole] < ROLE_RANK.admin;
}

// Two independent rules, not one:
//  - The URL is only masked from the read-only "user" role — CLAUDE.md's
//    obfuscation rule carves this out explicitly: admin/superadmin
//    already have full operational access to rules (create/edit/delete/
//    test), so seeing the real URL isn't a new capability.
//  - bearerToken is a real credential (not a webhook URL), so it's always
//    masked in read responses, for every role — same as ProtectConsole's
//    apiKey. The Rules edit form leaves it blank with a "leave blank to
//    keep the existing token" placeholder rather than ever round-tripping
//    the real value; PATCH only updates it when a new one is actually
//    typed (see /api/latches/[id]/route.ts).
// "console" kind has neither field, so it passes through unchanged.
// Exported for consoleRedaction.ts, which applies the same rule to a
// console's downAlertWebhook/downAlertResolvedWebhook — one webhook
// visibility rule, not two hand-maintained copies of it.
export function redactWebhookTarget(target: WebhookTarget, maskUrl: boolean): WebhookTarget {
  if (target.kind === "console") return target;
  return {
    ...target,
    url: maskUrl ? maskSecret(target.url) : target.url,
    bearerToken: target.bearerToken ? maskSecret(target.bearerToken) : undefined,
  };
}

export function redactLatch(latch: Latch, actorRole: Role) {
  const maskUrl = shouldMaskWebhookUrl(actorRole);
  return {
    ...latch,
    webhook: redactWebhookTarget(latch.webhook, maskUrl),
    resolvedWebhook: latch.resolvedWebhook ? redactWebhookTarget(latch.resolvedWebhook, maskUrl) : undefined,
  };
}
