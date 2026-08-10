import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser } from "@/lib/auth";

// Self-service display preference — every account (including "user" role)
// sets its own, same as password change. No role gate, only session auth.
export async function PATCH(req: NextRequest) {
  const actor = await getSessionUser();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  if (body.temperatureUnit !== "C" && body.temperatureUnit !== "F") {
    return NextResponse.json({ error: "temperatureUnit must be \"C\" or \"F\"" }, { status: 400 });
  }

  const updated = getEngine().auth.setTemperatureUnit(actor.id, body.temperatureUnit);
  return NextResponse.json({ user: updated });
}
