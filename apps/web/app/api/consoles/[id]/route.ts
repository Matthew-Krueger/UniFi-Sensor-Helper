import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUserId } from "@/lib/session";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const engine = getEngine();
  engine.disconnectConsole(id);
  engine.config.deleteProtectConsole(id);
  return NextResponse.json({ ok: true });
}
