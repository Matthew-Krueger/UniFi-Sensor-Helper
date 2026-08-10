import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { intervalTooShortMessage, isDurationValid, validateCondition, validateWebhookTarget } from "@unifi-sensor-latch/shared";
import type { Latch } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";

export async function GET() {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;
  const latches = getEngine().config.listLatches().map((l) => redactLatch(l, actor.role));
  return NextResponse.json({ latches });
}

export async function POST(req: NextRequest) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const latch = (await req.json()) as Latch;

  const conditionCheck = validateCondition(latch.condition);
  if (!conditionCheck.valid) {
    return NextResponse.json({ error: conditionCheck.error }, { status: 400 });
  }

  const webhookCheck = validateWebhookTarget(latch.webhook);
  if (!webhookCheck.valid) {
    return NextResponse.json({ error: webhookCheck.error }, { status: 400 });
  }
  if (latch.resolvedWebhook) {
    const resolvedCheck = validateWebhookTarget(latch.resolvedWebhook);
    if (!resolvedCheck.valid) {
      return NextResponse.json({ error: resolvedCheck.error }, { status: 400 });
    }
  }

  const engine = getEngine();
  const interval = engine.getEffectiveInterval(latch.sensorId, latch.metric);
  if (interval && !isDurationValid(latch.durationSeconds, interval)) {
    return NextResponse.json({ error: intervalTooShortMessage(latch.durationSeconds, interval) }, { status: 400 });
  }

  engine.config.upsertLatch(latch);
  return NextResponse.json({ latch: redactLatch(latch, actor.role) }, { status: 201 });
}
