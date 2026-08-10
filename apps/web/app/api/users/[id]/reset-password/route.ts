import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

// Generates a brand new random password for the target account (its old
// one stops working entirely, unlike invalidate-password) and forces a
// reset. Returned once in the response — never stored or logged in full —
// for the admin to relay to the account owner out-of-band.
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

  const result = await engine.auth.resetPasswordToRandom(id);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ user: result.user, generatedPassword: result.password });
}
