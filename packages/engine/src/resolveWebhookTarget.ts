import type { WebhookTarget } from "@unifi-sensor-latch/shared";
import { buildConsoleWebhookUrl } from "@unifi-sensor-latch/shared";
import type { ConfigStore } from "./config";
import type { ResolvedWebhookTarget } from "./webhookDispatcher";

// Turns a stored WebhookTarget (see shared/src/types.ts) into a concrete
// request — the one place that needs both the WebhookTarget union and a
// ConfigStore, so it lives in the engine, not shared/. "console" kind
// authenticates with that console's own API key (confirmed against the
// live Protect API: POST /v1/alarm-manager/webhook/{id} takes an
// X-API-KEY header, same as every other Integration API call) — never
// logged in full (webhookDispatcher.ts only ever logs the masked URL,
// never headers).
export function resolveWebhookTarget(target: WebhookTarget, config: ConfigStore): ResolvedWebhookTarget {
  if (target.kind === "custom") {
    return {
      url: target.url,
      method: target.method,
      headers: target.bearerToken ? { Authorization: `Bearer ${target.bearerToken}` } : undefined,
      bodyTemplate: target.bodyTemplate,
    };
  }

  const console_ = config.getProtectConsole(target.consoleId);
  if (!console_) {
    throw new Error(`console webhook targets console "${target.consoleId}", which no longer exists`);
  }

  return {
    url: buildConsoleWebhookUrl(console_.host, target.webhookId),
    method: "POST",
    headers: { "X-API-Key": console_.apiKey, Accept: "application/json" },
    // Protect consoles run a self-signed cert by default — see
    // ResolvedWebhookTarget's doc comment.
    insecure: true,
  };
}
