/**
 * Clerk's middleware, registered only when Clerk is configured.
 *
 * `auth()` in a server component needs `clerkMiddleware` to have run on the
 * request; without keys it throws. So this is conditional, and the condition is
 * read at module load rather than per request — the keys do not change while
 * the process is alive, and a per-request check would put a branch on the
 * authentication path of every page.
 *
 * **This is not the security boundary.** Middleware runs on the Edge runtime and
 * sees only the request; the gate that matters is `requireSession()`, called by
 * every page *and every server action*. A server action is a POST endpoint
 * reachable by identifier without rendering the page that contains its form, so
 * a middleware matcher written around page paths would miss exactly the calls
 * that change state.
 *
 * What this does buy: Clerk's session cookie is parsed and available to
 * `auth()`, which is the only reason it exists.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const clerkConfigured =
  (process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? "") !== "" &&
  (process.env["CLERK_SECRET_KEY"] ?? "") !== "";

export default async function middleware(request: NextRequest) {
  if (!clerkConfigured) return NextResponse.next();

  // Imported here so a development process never loads Clerk at all. A
  // top-level import would run its initialisation on every request in an
  // environment that has no keys for it.
  const { clerkMiddleware } = await import("@clerk/nextjs/server");
  return clerkMiddleware()(request, {} as never);
}

export const config = {
  // Everything except Next's own assets. Deliberately broad: the point is that
  // `auth()` works wherever it is called, not that this file decides who may go
  // where.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
