import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

// Manually fires a rule's "fired" webhook (Rules page's Test button) —
// never touches latch_state, so it can't accidentally arm/fire/clear the
// rule for real. Recorded to webhook_deliveries as kind "test" so it's
// never confused with an actual alarm — see LatchEngine.sendTestWebhook.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  try {
    await getEngine().sendTestWebhook(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }

  const deliveries = getEngine().listWebhookDeliveries(id);
  return NextResponse.json({ delivery: deliveries[0] ?? null });
}
