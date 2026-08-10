import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { intervalSecondsSchema } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

// Per-sensor expected-interval override — see packages/shared/src/interval.ts.
// null clears the override (falls back to the console default).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const existing = engine.config.listSensors().find((s) => s.id === id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json();
  if (body.expectedIntervalSeconds === null) {
    engine.config.setSensorExpectedInterval(id, null);
    return NextResponse.json({ ok: true });
  }

  const interval = intervalSecondsSchema.safeParse(body.expectedIntervalSeconds);
  if (!interval.success) return NextResponse.json({ error: interval.error.issues[0]?.message }, { status: 400 });

  engine.config.setSensorExpectedInterval(id, interval.data);
  return NextResponse.json({ ok: true });
}
