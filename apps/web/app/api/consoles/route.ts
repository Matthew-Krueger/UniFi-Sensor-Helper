import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import {
  consoleApiBaseUrlOverrideSchema,
  consoleApiKeySchema,
  consoleHostSchema,
  consoleNameSchema,
  consoleWebhookIdSchema,
  isDurationValid,
  MIN_DURATION_SECONDS,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import type { ProtectConsole, WebhookTarget } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";
import { redactConsole } from "@/lib/consoleRedaction";

export async function GET() {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;
  const engine = getEngine();
  const consoles = engine.config.listProtectConsoles().map((c) => redactConsole(c, actor.role));
  const statuses = engine.listConsoleStatuses();
  return NextResponse.json({ consoles, statuses });
}

export async function POST(req: NextRequest) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const body = await req.json();
  const name = consoleNameSchema.safeParse(body.name);
  if (!name.success) return NextResponse.json({ error: name.error.issues[0]?.message }, { status: 400 });
  const host = consoleHostSchema.safeParse(body.host);
  if (!host.success) return NextResponse.json({ error: host.error.issues[0]?.message }, { status: 400 });
  const apiKey = consoleApiKeySchema.safeParse(body.apiKey);
  if (!apiKey.success) return NextResponse.json({ error: apiKey.error.issues[0]?.message }, { status: 400 });

  let defaultWebhookId: string | null = null;
  if (body.defaultWebhookId) {
    const webhookId = consoleWebhookIdSchema.safeParse(body.defaultWebhookId);
    if (!webhookId.success) return NextResponse.json({ error: webhookId.error.issues[0]?.message }, { status: 400 });
    defaultWebhookId = webhookId.data;
  }

  let apiBaseUrlOverride: string | null = null;
  if (body.apiBaseUrlOverride) {
    const override = consoleApiBaseUrlOverrideSchema.safeParse(body.apiBaseUrlOverride);
    if (!override.success) return NextResponse.json({ error: override.error.issues[0]?.message }, { status: 400 });
    apiBaseUrlOverride = override.data;
  }

  const downAlertEnabled = body.downAlertEnabled === true;
  let downAlertDurationSeconds: number | null = null;
  let downAlertWebhook: WebhookTarget | null = null;
  let downAlertResolvedWebhook: WebhookTarget | null = null;
  if (downAlertEnabled) {
    if (!Number.isFinite(body.downAlertDurationSeconds) || !isDurationValid(body.downAlertDurationSeconds)) {
      return NextResponse.json(
        { error: `down alert duration must be at least ${MIN_DURATION_SECONDS} seconds` },
        { status: 400 }
      );
    }
    downAlertDurationSeconds = body.downAlertDurationSeconds;

    const webhookCheck = validateWebhookTarget(body.downAlertWebhook);
    if (!webhookCheck.valid) return NextResponse.json({ error: webhookCheck.error }, { status: 400 });
    downAlertWebhook = body.downAlertWebhook;

    if (body.downAlertResolvedWebhook) {
      const resolvedCheck = validateWebhookTarget(body.downAlertResolvedWebhook);
      if (!resolvedCheck.valid) return NextResponse.json({ error: resolvedCheck.error }, { status: 400 });
      downAlertResolvedWebhook = body.downAlertResolvedWebhook;
    }
  }

  const engine = getEngine();
  const id: string = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const console_: ProtectConsole = {
    id,
    name: name.data,
    host: host.data,
    apiKey: apiKey.data,
    apiBaseUrlOverride,
    defaultWebhookId,
    downAlertEnabled,
    downAlertDurationSeconds,
    downAlertWebhook,
    downAlertResolvedWebhook,
    createdAt: Date.now(),
  };

  engine.config.upsertProtectConsole(console_);

  // Not awaited: connectConsole can take several seconds (probe, discover,
  // subscribe, each with its own timeout — see protect.ts) and records a
  // step-by-step trace as it goes (ConsoleStatus.steps) rather than making
  // this request hang until the whole sequence finishes. The UI polls GET
  // /api/consoles to watch that trace land in near-real-time.
  engine.connectConsole(console_).catch((err) => {
    console.error("[api/consoles] connectConsole failed:", err);
  });

  return NextResponse.json({ console: redactConsole(console_, actor.role) }, { status: 201 });
}
