import { redirect } from "next/navigation";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser } from "@/lib/auth";
import { redactConsole } from "@/lib/consoleRedaction";
import { SensorsClient } from "./sensors-client";

// Server Component: resolves the session and reads the same engine state
// GET /api/sensors and GET /api/consoles would return, before any HTML
// ships — SensorsClient is seeded with it so first paint already shows
// real data instead of an empty state that pops in a moment later.
// SessionGuard (client-side) still handles the "session goes invalid
// mid-visit" case; this redirect only covers a cold, unauthenticated load.
export default async function SensorsPage() {
  const actor = await getSessionUser();
  if (!actor) redirect("/login");

  const engine = getEngine();
  const initial = {
    sensors: engine.config.listSensors(),
    statuses: engine.listSensorStatuses(),
    consoles: engine.config.listProtectConsoles().map((c) => redactConsole(c, actor.role)),
    consoleStatuses: engine.listConsoleStatuses(),
  };

  return <SensorsClient initial={initial} />;
}
