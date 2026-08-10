import { redirect } from "next/navigation";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";
import { DashboardClient } from "./dashboard-client";

// Server Component mirroring GET /api/latches, GET /api/sensors, and GET
// /api/state — first paint already has real rule/state cards instead of
// the "No rules configured yet" empty state popping in a moment later.
// SessionGuard (client-side) still handles a session going invalid
// mid-visit; this redirect only covers a cold, unauthenticated load.
export default async function DashboardPage() {
  const actor = await getSessionUser();
  if (!actor) redirect("/login");

  const engine = getEngine();
  const initial = {
    rules: engine.config.listLatches().map((l) => redactLatch(l, actor.role)),
    sensors: engine.config.listSensors(),
    states: engine.config.listLatchStates(),
  };

  return <DashboardClient initial={initial} />;
}
