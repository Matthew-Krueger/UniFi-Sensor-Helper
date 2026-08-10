import type { WebhookTarget } from "./types";

// Confirmed live against the Protect Integration API (API_NOTES.md):
// POST /v1/alarm-manager/webhook/{id}, X-API-KEY auth, 204 on success,
// path param is a user-defined ID that must match an Alarm Manager rule
// (trigger type = Webhook) configured once in Protect's own UI (SPEC.md
// section 7). Base path matches every other Protect Integration API call
// this app makes (see protect.ts).
export function buildConsoleWebhookUrl(host: string, webhookId: string): string {
  return `https://${host}/proxy/protect/integration/v1/alarm-manager/webhook/${webhookId}`;
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
  return { valid: true };
}
