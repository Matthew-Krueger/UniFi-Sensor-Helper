import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { intervalSecondsSchema } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

// Currently only defaultIntervalSeconds is editable post-creation — name/
// host/apiKey changes go through delete + re-add, since those changes
// also mean reconnecting anyway.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const existing = engine.config.getProtectConsole(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json();
  const interval = intervalSecondsSchema.safeParse(body.defaultIntervalSeconds);
  if (!interval.success) return NextResponse.json({ error: interval.error.issues[0]?.message }, { status: 400 });

  engine.config.setConsoleDefaultInterval(id, interval.data);

  // The periodic re-poll timer (see singleton.ts's connectConsole) is
  // only ever created once, using whatever defaultIntervalSeconds was
  // current at connect time — it doesn't watch the database for changes.
  // Without reconnecting here, editing the interval in the UI would
  // silently do nothing to the already-running timer until the next full
  // reconnect (a server restart, or manually removing/re-adding the
  // console) — exactly the kind of "changed a setting, nothing happened"
  // bug this project can't afford. Not awaited, same as POST — the trace
  // in GET /api/consoles's response shows the reconnect happening.
  const updated = engine.config.getProtectConsole(id);
  if (updated) {
    engine.connectConsole(updated).catch((err) => {
      console.error("[api/consoles] reconnect after interval update failed:", err);
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
