import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { canAssignRole } from "@unifi-sensor-latch/shared";
import type { Role } from "@unifi-sensor-latch/shared";
import { getSessionUser, hasRole } from "@/lib/auth";

const VALID_ROLES: Role[] = ["user", "admin", "superadmin"];

export async function GET() {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "admin")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const users = getEngine().auth.listUsers();
  return NextResponse.json({ users });
}

// Two distinct paths, both landing here:
//
//  1. Sign-up while the users table is empty — no session required. This
//     is intentionally an open door (per project decision: "as long as
//     there's an EXPLICIT check that you can't do this unless no other
//     accounts exist"). AuthStore.addUser forces the first account to
//     "superadmin" regardless of what's requested, so there's always
//     exactly one bootstrap superadmin and never a passwordless deployment.
//
//  2. Account creation by an existing admin/superadmin, once at least one
//     account exists — requires a session, and the requested role must be
//     one the actor is allowed to grant (canAssignRole, SPEC.md section 3).
export async function POST(req: NextRequest) {
  const engine = getEngine();
  const { username, password, role } = await req.json();

  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  }

  const isBootstrap = engine.auth.count() === 0;

  if (!isBootstrap) {
    const actor = await getSessionUser();
    if (!actor || !hasRole(actor, "admin")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const requestedRole: Role = VALID_ROLES.includes(role) ? role : "user";
    if (!canAssignRole(actor.role, requestedRole)) {
      return NextResponse.json({ error: `role "${requestedRole}" cannot be granted by your account` }, { status: 403 });
    }

    const user = await engine.auth.addUser(username, password, requestedRole);
    return NextResponse.json({ user }, { status: 201 });
  }

  // Bootstrap path: role is ignored — addUser always forces superadmin
  // when the table is empty, regardless of what's passed here.
  const user = await engine.auth.addUser(username, password);
  return NextResponse.json({ user }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const actor = await getSessionUser();
  if (!actor || !hasRole(actor, "admin")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await req.json();
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });

  const engine = getEngine();
  const target = engine.auth.getUser(id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (target.id === actor.id) {
    return NextResponse.json({ error: "cannot delete your own account" }, { status: 400 });
  }
  // admin can only remove "user" accounts; superadmin can remove anyone,
  // but never the last remaining superadmin (would lock the site out of
  // ever promoting/onboarding again).
  if (actor.role === "admin" && target.role !== "user") {
    return NextResponse.json({ error: "admins can only remove user accounts" }, { status: 403 });
  }
  if (target.role === "superadmin") {
    const superadmins = engine.auth.listUsers().filter((u) => u.role === "superadmin");
    if (superadmins.length <= 1) {
      return NextResponse.json({ error: "cannot remove the last superadmin" }, { status: 400 });
    }
  }

  engine.auth.removeUser(id);
  return NextResponse.json({ ok: true });
}
