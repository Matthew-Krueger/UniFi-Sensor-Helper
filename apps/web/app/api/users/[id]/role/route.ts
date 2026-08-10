import { NextRequest, NextResponse } from "next/server";
import { getEngine, RoleError } from "@unifi-sensor-latch/engine";
import type { Role } from "@unifi-sensor-latch/shared";
import { getSessionUser, hasRole } from "@/lib/auth";

const VALID_ROLES: Role[] = ["user", "admin", "superadmin"];

// Promotion/demotion — the one action restricted to superadmin, per the
// project's role model (an admin can create accounts but never elevate one
// to admin/superadmin, or change anyone's role at all).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "superadmin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { role } = await req.json();
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }

  const engine = getEngine();
  const target = engine.auth.getUser(id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (target.role === "superadmin" && role !== "superadmin") {
    const superadmins = engine.auth.listUsers().filter((u) => u.role === "superadmin");
    if (superadmins.length <= 1) {
      return NextResponse.json({ error: "cannot demote the last superadmin" }, { status: 400 });
    }
  }

  try {
    const updated = await engine.auth.setRole(actor.role, id, role as Role);
    return NextResponse.json({ user: updated });
  } catch (err) {
    if (err instanceof RoleError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
