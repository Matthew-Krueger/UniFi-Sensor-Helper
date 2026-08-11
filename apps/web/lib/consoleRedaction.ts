import type { ProtectConsole, Role } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";
import { redactWebhookTarget, shouldMaskWebhookUrl } from "./latchRedaction";

// apiKey is secret-bearing: never echoed back in full, same rule as
// webhook URLs (CLAUDE.md obfuscation). Shared by GET /api/consoles and
// the server-rendered Sensors/Consoles pages so there's one place this
// rule lives, not hand-maintained copies. downAlertWebhook/
// downAlertResolvedWebhook follow the same admin-sees-full/user-sees-
// masked rule as a Latch's webhook (see latchRedaction.ts) — actorRole
// defaults to "user" (the most restrictive) so any call site that
// forgets to pass it fails safe rather than leaking a URL.
export function redactConsole(console_: ProtectConsole, actorRole: Role = "user"): ProtectConsole {
  const maskUrl = shouldMaskWebhookUrl(actorRole);
  return {
    ...console_,
    apiKey: maskSecret(console_.apiKey),
    downAlertWebhook: console_.downAlertWebhook ? redactWebhookTarget(console_.downAlertWebhook, maskUrl) : null,
    downAlertResolvedWebhook: console_.downAlertResolvedWebhook
      ? redactWebhookTarget(console_.downAlertResolvedWebhook, maskUrl)
      : null,
  };
}
