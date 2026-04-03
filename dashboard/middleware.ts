import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const auth = request.cookies.get("atlas_auth")?.value;
  if (auth !== process.env.DASHBOARD_PASSWORD) {
    if (request.nextUrl.pathname === "/login") return NextResponse.next();
    if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
