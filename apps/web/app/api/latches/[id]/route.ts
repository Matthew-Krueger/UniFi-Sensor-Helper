import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { maskSecret } from "@unifi-sensor-latch/shared";
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
