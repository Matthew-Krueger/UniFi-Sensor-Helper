import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { intervalTooShortMessage, isDurationValid, maskSecret } from "@unifi-sensor-latch/shared";
import type { Latch } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

function redactLatch(latch: Latch) {
  return {
    ...latch,
    webhook: { ...latch.webhook, url: maskSecret(latch.webhook.url) },
    resolvedWebhook: latch.resolvedWebhook
      ? { ...latch.resolvedWebhook, url: maskSecret(latch.resolvedWebhook.url) }
      : undefined,
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const existing = engine.config.listLatches().find((l) => l.id === id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch = (await req.json()) as Partial<Latch>;
  const updated: Latch = { ...existing, ...patch, id };

  // Only re-check when something that affects the duration/interval
  // relationship actually changed — a pure enable/disable toggle
  // shouldn't suddenly fail because the sensor's observed interval
  // drifted since the rule was created.
  if (patch.durationSeconds !== undefined || patch.sensorId !== undefined || patch.metric !== undefined) {
    const interval = engine.getEffectiveInterval(updated.sensorId, updated.metric);
    if (interval && !isDurationValid(updated.durationSeconds, interval)) {
      return NextResponse.json({ error: intervalTooShortMessage(updated.durationSeconds, interval) }, { status: 400 });
    }
  }

  engine.config.upsertLatch(updated);
  return NextResponse.json({ latch: redactLatch(updated) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  getEngine().config.deleteLatch(id);
  return NextResponse.json({ ok: true });
}
