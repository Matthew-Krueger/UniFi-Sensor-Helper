import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

// Marks the target's current password as no longer sufficient — it still
// authenticates, but the account can't do anything else until it's
// changed. Doesn't rotate the hash, so nothing needs to be relayed to the
// account owner if they still remember their existing password.
export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const target = engine.auth.getUser(id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (actor.role === "admin" && target.role !== "user") {
    return NextResponse.json({ error: "admins can only manage user accounts" }, { status: 403 });
  }

  const updated = engine.auth.invalidatePassword(id);
  return NextResponse.json({ user: updated });
}
