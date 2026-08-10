import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { getSessionUserId } from "@/lib/session";

// TODO(SPEC.md section 8): discover sensors from the Protect API instead of
// only reading back what's already stored. This stub only reflects the
// config store's current contents.
export async function GET() {
  if (!(await getSessionUserId())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sensors = getEngine().config.listSensors();
  return NextResponse.json({ sensors });
}
