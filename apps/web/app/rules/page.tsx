import { redirect } from "next/navigation";
import { getEngine } from "@unifi-sensor-latch/engine";
import type { WebhookDelivery } from "@unifi-sensor-latch/shared";
import { getSessionUser, hasRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";
import { redactConsole } from "@/lib/consoleRedaction";
import { RulesClient, type RuleRow } from "./rules-client";

// Server Component mirroring GET /api/latches, GET /api/sensors, GET
// /api/consoles, and (admin-only) GET /api/latches/[id]/deliveries —
// same engine calls, same role-based redaction — so RulesClient's first
// paint already has real data instead of an empty table that pops in a
// moment later. SessionGuard (client-side) still handles a session going
// invalid mid-visit; this redirect only covers a cold, unauthenticated
// load.
export default async function RulesPage() {
  const actor = await getSessionUser();
  if (!actor) redirect("/login");

  const engine = getEngine();
  const rules = engine.config.listLatches().map((l) => redactLatch(l, actor.role)) as RuleRow[];
  const sensors = engine.config.listSensors();
  const sensorStatuses = engine.listSensorStatuses();
  const consoles = engine.config.listProtectConsoles().map((c) => redactConsole(c, actor.role));

  const canEdit = hasRole(actor, "admin");
  const deliveries: Record<string, WebhookDelivery[]> = {};
  if (canEdit) {
    for (const rule of rules) {
      deliveries[rule.id] = engine.listWebhookDeliveries(rule.id);
    }
  }

  const initial = { rules, sensors, sensorStatuses, consoles, deliveries };

  return <RulesClient initial={initial} />;
}
