import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  engine.disconnectConsole(id);
  engine.config.deleteProtectConsole(id);
  return NextResponse.json({ ok: true });
}
