import { redirect } from "next/navigation";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser } from "@/lib/auth";
import { redactConsole } from "@/lib/consoleRedaction";
import { ConsolesClient } from "./consoles-client";

// Server Component mirroring GET /api/consoles — first paint already has
// real console cards instead of an empty state that pops in a moment
// later. SessionGuard (client-side) still handles a session going invalid
// mid-visit; this redirect only covers a cold, unauthenticated load.
export default async function ConsolesPage() {
  const actor = await getSessionUser();
  if (!actor) redirect("/login");

  const engine = getEngine();
  const initial = {
    consoles: engine.config.listProtectConsoles().map(redactConsole),
    statuses: engine.listConsoleStatuses(),
  };

  return <ConsolesClient initial={initial} />;
}
