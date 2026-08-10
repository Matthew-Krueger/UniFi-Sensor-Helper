import type { WebhookTarget } from "./types";
import { webhookBodyTemplateSchema } from "./validation";

// Base URL for a console's Protect Integration API — normally derived from
// its host, but overridable per-console (ProtectConsole.apiBaseUrlOverride)
// for the rare case of reaching a console through something other than a
// direct LAN path, e.g. UniFi's remote/cloud API base. Shared by
// protect.ts (engine's own API calls) and buildConsoleWebhookUrl below, so
// the override applies consistently everywhere a console's API is reached.
export function protectApiBase(host: string, apiBaseUrlOverride?: string | null): string {
  if (apiBaseUrlOverride && apiBaseUrlOverride.trim()) {
    return apiBaseUrlOverride.trim().replace(/\/+$/, "");
  }
  return `https://${host}/proxy/protect/integration`;
}

// Confirmed live against the Protect Integration API (API_NOTES.md):
// POST /v1/alarm-manager/webhook/{id}, X-API-KEY auth, 204 on success,
// path param is a user-defined ID that must match an Alarm Manager rule
// (trigger type = Webhook) configured once in Protect's own UI (SPEC.md
// section 7). Base path matches every other Protect Integration API call
// this app makes (see protect.ts).
export function buildConsoleWebhookUrl(host: string, webhookId: string, apiBaseUrlOverride?: string | null): string {
  return `${protectApiBase(host, apiBaseUrlOverride)}/v1/alarm-manager/webhook/${webhookId}`;
}

export interface WebhookValidationResult {
  valid: boolean;
  error?: string;
}

// Shape-only validation, shared between the Rules form and the
// /api/latches routes' server-side gate (CLAUDE.md trust boundaries) —
// whether a "console" kind's consoleId actually exists is checked
// separately at resolve time (packages/engine/src/resolveWebhookTarget.ts),
// since that needs a ConfigStore this module deliberately doesn't depend on.
export function validateWebhookTarget(target: WebhookTarget): WebhookValidationResult {
  if (target.kind === "console") {
    if (!target.consoleId) return { valid: false, error: "Select a console for this webhook." };
    if (!target.webhookId.trim()) return { valid: false, error: "A console webhook needs a webhook ID." };
    return { valid: true };
  }

  if (!/^https?:\/\/.+/i.test(target.url)) {
    return { valid: false, error: "Webhook URL must start with http:// or https://" };
  }
  if (target.bodyTemplate !== undefined) {
    const check = webhookBodyTemplateSchema.safeParse(target.bodyTemplate);
    if (!check.success) return { valid: false, error: check.error.issues[0]?.message };
  }
  return { valid: true };
}
