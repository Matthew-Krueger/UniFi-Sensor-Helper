import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUserId } from "@/lib/session";

async function requireAuth() {
  const userId = await getSessionUserId();
  return userId !== null;
}

export async function GET() {
  if (!(await requireAuth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const users = getEngine().auth.listUsers();
  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { username, password } = await req.json();
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  }

  const user = await getEngine().auth.addUser(username, password);
  return NextResponse.json({ user }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await req.json();
  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  getEngine().auth.removeUser(id);
  return NextResponse.json({ ok: true });
}
