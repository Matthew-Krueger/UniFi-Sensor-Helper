import { NextRequest, NextResponse } from "next/server";

// Kept generic/available regardless of whether ingest ends up being
// push-from-Protect or poll/subscribe-from-us (SPEC.md section 5/8). Calls
// directly into the engine singleton — does not run or own the engine.
// TODO(section 8): once the ingest strategy is finalized, parse the actual
// Protect payload shape here and call getEngine().ingest(...).
export async function POST(_req: NextRequest) {
  return NextResponse.json({ error: "inbound webhook ingest not yet implemented" }, { status: 501 });
}
