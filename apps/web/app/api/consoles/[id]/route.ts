import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import type { ProtectConsole } from "@unifi-sensor-latch/shared";
import {
  consoleApiKeySchema,
  consoleHostSchema,
  consoleNameSchema,
  consoleWebhookIdSchema,
  intervalSecondsSchema,
} from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

// Full edit — every field is optional in the request body; only what's
// present gets validated/changed. apiKey is the one field that's never
// echoed back in full (GET masks it — CLAUDE.md obfuscation), so the edit
// form always leaves it blank with a "leave blank to keep the existing
// key" placeholder: an omitted/empty apiKey here means "keep whatever's
// already stored," never "clear it."
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const existing = engine.config.getProtectConsole(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json();
  const updated: ProtectConsole = { ...existing };
  let connectivityAffected = false;

  if (body.name !== undefined) {
    const name = consoleNameSchema.safeParse(body.name);
    if (!name.success) return NextResponse.json({ error: name.error.issues[0]?.message }, { status: 400 });
    updated.name = name.data;
  }

  if (body.host !== undefined) {
    const host = consoleHostSchema.safeParse(body.host);
    if (!host.success) return NextResponse.json({ error: host.error.issues[0]?.message }, { status: 400 });
    updated.host = host.data;
    connectivityAffected = true;
  }

  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const apiKey = consoleApiKeySchema.safeParse(body.apiKey);
    if (!apiKey.success) return NextResponse.json({ error: apiKey.error.issues[0]?.message }, { status: 400 });
    updated.apiKey = apiKey.data;
    connectivityAffected = true;
  }

  if (body.defaultIntervalSeconds !== undefined) {
    const interval = intervalSecondsSchema.safeParse(body.defaultIntervalSeconds);
    if (!interval.success) return NextResponse.json({ error: interval.error.issues[0]?.message }, { status: 400 });
    updated.defaultIntervalSeconds = interval.data;
    connectivityAffected = true; // re-poll cadence is set at connect time — see comment below
  }

  if (body.defaultWebhookId !== undefined) {
    if (body.defaultWebhookId === null || body.defaultWebhookId === "") {
      updated.defaultWebhookId = null;
    } else {
      const webhookId = consoleWebhookIdSchema.safeParse(body.defaultWebhookId);
      if (!webhookId.success) return NextResponse.json({ error: webhookId.error.issues[0]?.message }, { status: 400 });
      updated.defaultWebhookId = webhookId.data;
    }
  }

  engine.config.upsertProtectConsole(updated);

  // The websocket subscription and periodic re-poll timer (see
  // singleton.ts's connectConsole) are only ever set up once, using
  // whatever host/apiKey/defaultIntervalSeconds was current at connect
  // time — they don't watch the database for changes. Without
  // reconnecting here, editing any of those in the UI would silently do
  // nothing to the already-running connection until the next full
  // reconnect (a server restart, or manually removing/re-adding the
  // console) — exactly the kind of "changed a setting, nothing happened"
  // bug this project can't afford. Not awaited — the trace in GET
  // /api/consoles's response shows the reconnect happening. Skipped for
  // name/defaultWebhookId-only edits, which don't affect the live
  // connection at all.
  if (connectivityAffected) {
    engine.connectConsole(updated).catch((err) => {
      console.error("[api/consoles] reconnect after edit failed:", err);
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  engine.disconnectConsole(id);
  engine.config.deleteProtectConsole(id);
  return NextResponse.json({ ok: true });
}
