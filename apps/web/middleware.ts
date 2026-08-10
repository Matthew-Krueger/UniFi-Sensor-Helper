import { NextRequest, NextResponse } from "next/server";

// Redirects unauthenticated requests for any page (not API route — those
// already 401 themselves, see lib/session.ts's getSessionUserId callers) to
// /login. Without this, page shells render for anyone with network access
// to the app even though the data underneath is gated — a UX gap, not a
// data leak, but still worth closing.
const COOKIE_NAME = "usl_session";

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has(COOKIE_NAME);
  if (!hasSession && req.nextUrl.pathname !== "/login") {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
