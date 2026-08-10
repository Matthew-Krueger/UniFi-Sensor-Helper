import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { maskSecret } from "@unifi-sensor-latch/shared";
import type { Latch } from "@unifi-sensor-latch/shared";
import { getSessionUser, hasRole } from "@/lib/auth";

// Webhook URLs can embed a bearer-token-equivalent ID (SPEC.md section 6 /
// CLAUDE.md secret obfuscation) — never echo them back in full.
function redactLatch(latch: Latch) {
  return {
    ...latch,
    webhook: { ...latch.webhook, url: maskSecret(latch.webhook.url) },
    resolvedWebhook: latch.resolvedWebhook
      ? { ...latch.resolvedWebhook, url: maskSecret(latch.resolvedWebhook.url) }
      : undefined,
  };
}

export async function GET() {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "user")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const latches = getEngine().config.listLatches().map(redactLatch);
  return NextResponse.json({ latches });
}

export async function POST(req: NextRequest) {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "admin")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const latch = (await req.json()) as Latch;
  // TODO: validate shape (sensorId exists, thresholds numeric, etc.) once
  // the Latches page is built out.
  getEngine().config.upsertLatch(latch);
  return NextResponse.json({ latch: redactLatch(latch) }, { status: 201 });
}
