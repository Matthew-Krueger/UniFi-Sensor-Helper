import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { passwordSchema } from "@unifi-sensor-latch/shared";
import { getSessionUser } from "@/lib/auth";

// Every account, including "user"-role (read-only) accounts, can change its
// own password — this isn't gated by role, only by proving the current one.
// currentPassword is deliberately NOT run through passwordSchema — it's
// whatever the account's existing password already is (could predate this
// validation rule, or be an admin-generated one), only newPassword must
// satisfy the strength requirement.
export async function PATCH(req: NextRequest) {
  const actor = await getSessionUser();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  if (typeof body.currentPassword !== "string") {
    return NextResponse.json({ error: "currentPassword is required" }, { status: 400 });
  }
  const newPassword = passwordSchema.safeParse(body.newPassword);
  if (!newPassword.success) {
    return NextResponse.json({ error: newPassword.error.issues[0]?.message }, { status: 400 });
  }

  const ok = await getEngine().auth.changePassword(actor.id, body.currentPassword, newPassword.data);
  if (!ok) return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });

  return NextResponse.json({ ok: true, user: getEngine().auth.getUser(actor.id) });
}
