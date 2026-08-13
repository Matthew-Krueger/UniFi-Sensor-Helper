import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";

// latchNameSchema caps names at 100 characters. A source name near that
// limit plus the " (copy)" suffix (7 chars) could exceed it, so the base
// is truncated to leave room, guaranteeing the copy can't fail
// re-validation on a later edit.
function buildCopyName(sourceName: string | null): string {
  const base = sourceName ?? "Untitled";
  const suffix = " (copy)";
  const maxBaseLength = 100 - suffix.length;
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base;
  return `${truncatedBase}${suffix}`;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const source = engine.config.listLatches().find((l) => l.id === id);
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });

  const copy = {
    ...source,
    id: crypto.randomUUID(),
    name: buildCopyName(source.name),
    enabled: false,
  };

  engine.config.upsertLatch(copy);

  return NextResponse.json({ latch: redactLatch(copy, actor.role) }, { status: 201 });
}
