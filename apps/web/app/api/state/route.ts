import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

// Polled by the dashboard every few seconds (SPEC.md section 5) — latch
// state changes on the order of minutes, so polling is simpler than a
// websocket-to-browser layer and sufficient here.
export async function GET() {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;
  const states = getEngine().config.listLatchStates();
  return NextResponse.json({ states });
}
