import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser, hasRole } from "@/lib/auth";

// Read-only reflection of what's already been discovered (see
// /api/sensors/discover for the actual live-discovery call). Any
// authenticated role, including read-only "user", can view this.
export async function GET() {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "user")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sensors = getEngine().config.listSensors();
  return NextResponse.json({ sensors });
}
