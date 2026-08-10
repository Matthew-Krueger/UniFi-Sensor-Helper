import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUser } from "@/lib/auth";

// Every account, including "user"-role (read-only) accounts, can change its
// own password — this isn't gated by role, only by proving the current one.
export async function PATCH(req: NextRequest) {
  const actor = await getSessionUser();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { currentPassword, newPassword } = await req.json();
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !newPassword) {
    return NextResponse.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
  }

  const ok = await getEngine().auth.changePassword(actor.id, currentPassword, newPassword);
  if (!ok) return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });

  return NextResponse.json({ ok: true });
}
