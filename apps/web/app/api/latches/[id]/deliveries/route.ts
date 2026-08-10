import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

// Admin-only: delivery history includes the un-masked webhook URL (see
// lib/latchRedaction.ts) and response bodies, which can echo back
// whatever the receiving endpoint returned — treat it the same as the
// rest of the Rules page's write-adjacent surface, not the read-only
// "user" role's view.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const deliveries = getEngine().listWebhookDeliveries(id);
  return NextResponse.json({ deliveries });
}
