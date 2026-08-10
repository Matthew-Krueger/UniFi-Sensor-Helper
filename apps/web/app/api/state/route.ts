import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUserId } from "@/lib/session";

// Polled by the dashboard every few seconds (SPEC.md section 5) — latch
// state changes on the order of minutes, so polling is simpler than a
// websocket-to-browser layer and sufficient here.
export async function GET() {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const states = getEngine().config.listLatchStates();
  return NextResponse.json({ states });
}
