import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { createSessionCookie, clearSessionCookie } from "@/lib/session";
import { getSessionUser } from "@/lib/auth";

// Current session (or null) plus whether sign-up is currently open (true
// only while the users table is empty — see POST /api/users). The login
// page uses this to decide whether to show a sign-in form or a first-run
// "create the first account" form.
export async function GET() {
  const user = await getSessionUser();
  const needsBootstrap = getEngine().auth.count() === 0;
  return NextResponse.json({ user, needsBootstrap });
}

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  }

  const user = await getEngine().auth.verify(username, password);
  if (!user) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  await createSessionCookie(user.id);
  return NextResponse.json({ user });
}

export async function DELETE() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
