import { z } from "zod";

// Runtime shape checks for API responses that get cached by query key in
// the one app-wide QueryClient (see components/query-provider.tsx) and
// therefore shared across pages — a page that narrows/reshapes the JSON
// before caching it under a key another page also uses can silently
// clobber that other page's cache entry with the wrong shape (see the
// "sensors is undefined"/"statuses is undefined" runtime crash this was
// added to catch). Parsing with zod here turns that class of bug into an
// immediate, readable error at the fetch site instead of a cryptic
// "can't access property X of undefined" deep in render.
export const sensorSchema = z.object({
  id: z.string(),
  consoleId: z.string(),
  name: z.string(),
  metrics: z.array(z.enum(["lux", "temperature", "humidity", "leak"])),
});

export const sensorStatusSchema = z.object({
  sensorId: z.string(),
  lastSeenAt: z.number().nullable(),
  values: z.record(z.string(), z.number()),
  observedCheckinIntervalSeconds: z.number().nullable(),
  battery: z.object({ percentage: z.number().nullable(), isLow: z.boolean() }).nullable(),
});

export const sensorsResponseSchema = z.object({
  sensors: z.array(sensorSchema),
  statuses: z.array(sensorStatusSchema),
});

const webhookTargetSchema = z.union([
  z.object({ kind: z.literal("console"), consoleId: z.string(), webhookId: z.string() }),
  z.object({
    kind: z.literal("custom"),
    url: z.string(),
    method: z.enum(["GET", "POST"]),
    bearerToken: z.string().optional(),
    bodyTemplate: z.string().optional(),
  }),
]);

export const protectConsoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  apiKey: z.string(), // always masked by the time it reaches the client — see CLAUDE.md
  apiBaseUrlOverride: z.string().nullable(),
  defaultWebhookId: z.string().nullable(),
  downAlertEnabled: z.boolean(),
  downAlertDurationSeconds: z.number().nullable(),
  downAlertWebhook: webhookTargetSchema.nullable(),
  downAlertResolvedWebhook: webhookTargetSchema.nullable(),
  createdAt: z.number(),
});

export const consoleStatusSchema = z.object({
  consoleId: z.string(),
  connectionState: z.enum(["connecting", "connected", "disconnected", "error"]),
  applicationVersion: z.string().nullable(),
  latencyMs: z.number().nullable(),
  lastEventAt: z.number().nullable(),
  sensorCount: z.number(),
  error: z.string().nullable(),
  steps: z.array(z.object({ label: z.string(), at: z.number(), ok: z.boolean() })),
  downAlertFired: z.boolean(),
});

export const consolesResponseSchema = z.object({
  consoles: z.array(protectConsoleSchema),
  statuses: z.array(consoleStatusSchema),
});
