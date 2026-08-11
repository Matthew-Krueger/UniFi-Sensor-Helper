import type { Latch } from "@unifi-sensor-latch/shared";
import { maskSecret, conditionThresholdTemplateValue } from "@unifi-sensor-latch/shared";
import { insecureTls } from "./protect";

// Fires the webhook configured on a Latch's "fired" or "resolvedWebhook"
// transition. Pure-ish: the only I/O is the injected `fetchImpl` (defaults
// to global fetch), which makes retries and masking testable without a
// real network call. Server-side log lines still mask the URL even though
// the UI no longer does for admins (CLAUDE.md) — logs land on disk/journal
// regardless of role, so this stays conservative independent of that.
//
// Takes an already-*resolved* target (concrete url/method/headers), not
// the stored WebhookTarget union — resolving "console" kind into a real
// URL + X-API-KEY header needs a ConfigStore lookup, which lives in
// resolveWebhookTarget.ts, not here. Keeps this module free of any engine
// dependency, same as before.
export interface ResolvedWebhookTarget {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  bodyTemplate?: string;
  // Set for "console" kind targets — Protect consoles run a self-signed
  // cert by default (API_NOTES.md), same as every other call this app
  // makes to one (see protect.ts's insecureTls). Never set for "custom"
  // targets: an arbitrary external URL should still get normal cert
  // verification.
  insecure?: boolean;
}

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
  target: ResolvedWebhookTarget,
  ctx: DispatchContext,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = RETRY_DELAY_MS
): Promise<DispatchResult> {
  const body = target.bodyTemplate ? renderTemplate(target.bodyTemplate, ctx) : undefined;
  return sendWithRetries(target, body, fetchImpl, retryDelayMs);
}

// Non-latch dispatch path — used by the console-down alert (see
// LatchEngine's downAlert handling), which has no Latch to build a
// DispatchContext from. Same retry/logging/masking behavior as
// dispatchWebhook, just a plain {{key}}: value substitution map instead
// of the latch-shaped one renderTemplate expects.
export async function dispatchWebhookWithVars(
  target: ResolvedWebhookTarget,
  vars: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = RETRY_DELAY_MS
): Promise<DispatchResult> {
  let body = target.bodyTemplate;
  if (body) {
    for (const [key, value] of Object.entries(vars)) {
      body = body.replaceAll(`{{${key}}}`, value);
    }
  }
  return sendWithRetries(target, body, fetchImpl, retryDelayMs);
}

async function sendWithRetries(
  target: ResolvedWebhookTarget,
  body: string | undefined,
  fetchImpl: typeof fetch,
  retryDelayMs: number
): Promise<DispatchResult> {
  const maskedUrl = maskSecret(target.url);

  let lastError: string | undefined;
  let lastResponseSnippet: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(target.url, {
        method: target.method,
        headers: target.headers,
        body: target.method === "POST" ? body : undefined,
        ...(target.insecure ? insecureTls : {}),
      } as RequestInit);
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
