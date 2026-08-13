import { NextResponse } from "next/server";
import { computeLatchStats, getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const latch = engine.config.listLatches().find((l) => l.id === id);
  if (!latch) return NextResponse.json({ error: "not found" }, { status: 404 });

  const events = engine.config.getLatchTransitions(id);
  const liveState = engine.config.getLatchState(id);
  const stats = computeLatchStats(events, liveState, Date.now());

  return NextResponse.json({ stats });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("superadmin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const url = new URL(req.url);
  if (url.searchParams.get("action") !== "clear") {
    return NextResponse.json({ error: "unsupported action" }, { status: 400 });
  }

  const engine = getEngine();
  const latch = engine.config.listLatches().find((l) => l.id === id);
  if (!latch) return NextResponse.json({ error: "not found" }, { status: 404 });

  engine.config.clearLatchTransitions(id);
  return NextResponse.json({ ok: true });
}
