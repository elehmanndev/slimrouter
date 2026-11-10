import { NextResponse, type NextRequest } from "next/server";

// Lightweight gate: dashboard pages and /api/admin need a session cookie when a password is set.
// The real check happens in the route handlers (they have Node APIs); here we only redirect pages.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth = !pathname.startsWith("/login") && !pathname.startsWith("/api/") && !pathname.startsWith("/v1") && !pathname.startsWith("/oauth/callback") && pathname !== "/callback" &&!pathname.startsWith("/_next");
  if (!needsAuth) return NextResponse.next();
  const hasCookie = !!request.cookies.get("slim_session")?.value;
  const passwordSet = !!process.env.DASHBOARD_PASSWORD || request.cookies.get("slim_pw")?.value === "1";
  if (passwordSet && !hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
