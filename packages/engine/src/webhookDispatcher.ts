import type { Latch, WebhookTarget } from "@unifi-sensor-latch/shared";
import { maskSecret, conditionThresholdTemplateValue } from "@unifi-sensor-latch/shared";

// Fires the webhook configured on a Latch's "fired" or "resolvedWebhook"
// transition. Pure-ish: the only I/O is the injected `fetchImpl` (defaults
// to global fetch), which makes retries and masking testable without a
// real network call. Never logs a webhook URL in full — CLAUDE.md secret
// obfuscation, since a URL can embed a token/id that's a bearer credential.

export interface DispatchContext {
  latch: Latch;
  sensorName: string;
  value: number;
}

export interface DispatchResult {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
  responseBodySnippet?: string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
// Response bodies are stored (see ConfigStore.recordWebhookDelivery), not
// just logged — capped so a misbehaving endpoint returning a huge body
// can't bloat the database.
const MAX_RESPONSE_SNIPPET_LENGTH = 2000;

async function readResponseSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return text.length > MAX_RESPONSE_SNIPPET_LENGTH ? `${text.slice(0, MAX_RESPONSE_SNIPPET_LENGTH)}…` : text;
  } catch {
    return undefined;
  }
}

function renderTemplate(template: string, ctx: DispatchContext): string {
  const durationMinutes = Math.round(ctx.latch.durationSeconds / 60);
  return template
    .replaceAll("{{sensorName}}", ctx.sensorName)
    .replaceAll("{{metric}}", ctx.latch.metric)
    .replaceAll("{{value}}", String(ctx.value))
    .replaceAll("{{threshold}}", conditionThresholdTemplateValue(ctx.latch.condition))
    .replaceAll("{{durationMinutes}}", String(durationMinutes));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dispatchWebhook(
  target: WebhookTarget,
  ctx: DispatchContext,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = RETRY_DELAY_MS
): Promise<DispatchResult> {
  const body = target.bodyTemplate ? renderTemplate(target.bodyTemplate, ctx) : undefined;
  const maskedUrl = maskSecret(target.url);

  let lastError: string | undefined;
  let lastResponseSnippet: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(target.url, {
        method: target.method,
        headers: target.headers,
        body: target.method === "POST" ? body : undefined,
      });
      lastResponseSnippet = await readResponseSnippet(res);

      if (res.ok) {
        console.log(`[webhook] ${target.method} ${maskedUrl} -> ${res.status} (attempt ${attempt})`);
        return { ok: true, status: res.status, attempts: attempt, responseBodySnippet: lastResponseSnippet };
      }

      lastError = `HTTP ${res.status}`;
      console.warn(`[webhook] ${target.method} ${maskedUrl} -> ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[webhook] ${target.method} ${maskedUrl} failed: ${lastError} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs);
  }

  console.error(`[webhook] ${target.method} ${maskedUrl} gave up after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  return { ok: false, attempts: MAX_ATTEMPTS, error: lastError, responseBodySnippet: lastResponseSnippet };
}
