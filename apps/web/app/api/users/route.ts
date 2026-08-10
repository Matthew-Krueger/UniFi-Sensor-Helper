import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { canAssignRole } from "@unifi-sensor-latch/shared";
import type { Role } from "@unifi-sensor-latch/shared";
import { requireRole } from "@/lib/auth";

const VALID_ROLES: Role[] = ["user", "admin", "superadmin"];

export async function GET() {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const users = getEngine().auth.listUsers();
  return NextResponse.json({ users });
}

// Two distinct paths, both landing here:
//
//  1. Sign-up while the users table is empty — no session required. This
//     is intentionally an open door (per project decision: "as long as
//     there's an EXPLICIT check that you can't do this unless no other
//     accounts exist"). The account owner chooses their own password here
//     (they're present, creating their own account) and AuthStore forces
//     it to "superadmin" regardless of what's requested.
//
//  2. Account creation by an existing admin/superadmin, once at least one
//     account exists — requires a session, and the requested role must be
//     one the actor is allowed to grant (canAssignRole, SPEC.md section
//     3a). The admin never chooses the new account's password — one is
//     randomly generated and returned once in the response for the admin
//     to relay out-of-band, and the account is forced to reset it before
//     doing anything else (mustResetPassword — see AuthStore).
export async function POST(req: NextRequest) {
  const engine = getEngine();
  const isBootstrap = engine.auth.count() === 0;

  if (isBootstrap) {
    const { username, password } = await req.json();
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return NextResponse.json({ error: "username and password are required" }, { status: 400 });
    }
    // role is ignored — addUser always forces superadmin when the table is empty.
    const user = await engine.auth.addUser(username, password);
    return NextResponse.json({ user }, { status: 201 });
  }

  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { username, role } = await req.json();
  if (typeof username !== "string" || !username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  const requestedRole: Role = VALID_ROLES.includes(role) ? role : "user";
  if (!canAssignRole(actor.role, requestedRole)) {
    return NextResponse.json({ error: `role "${requestedRole}" cannot be granted by your account` }, { status: 403 });
  }

  const { user, password } = await engine.auth.createUserWithGeneratedPassword(username, requestedRole);
  return NextResponse.json({ user, generatedPassword: password }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

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
