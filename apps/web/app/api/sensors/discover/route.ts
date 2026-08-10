import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUserId } from "@/lib/session";

// Manual "refresh" action for the Sensors page (SPEC.md section 5/12) — runs
// discovery against every configured Protect console and upserts the
// result. The websocket subscription (started in connectConsole) already
// keeps sensors' live readings flowing; this is only for picking up newly
// added/removed physical sensors without needing an app restart.
export async function POST() {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const engine = getEngine();
  const consoles = engine.config.listProtectConsoles();

  const errors: string[] = [];
  for (const console_ of consoles) {
    try {
      await engine.discoverSensors(console_);
    } catch (err) {
      errors.push(`${console_.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sensors = engine.config.listSensors();
  return NextResponse.json({ sensors, errors });
}
