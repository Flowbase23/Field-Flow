import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Clerk middleware — route protection.
 *
 * Public routes: the app root, sign-in/sign-up, the Clerk webhook receiver
 * (Clerk servers cannot carry a session cookie), and the CUSTOMER PORTAL
 * (P2-S4): /portal/* pages authorize purely by a high-entropy token in the URL
 * (no customer accounts, no Clerk session — see
 * src/features/portal/server/portal.actions.ts for the access model).
 * Everything else requires an authenticated session; org-scoped authorization
 * is layered on top in requireOrg()/requirePermission() (src/server/auth/require-org.ts).
 *
 * Note: Next.js 16 deprecates middleware.ts in favor of proxy.ts; this file
 * still works and is kept because the team's design names middleware.ts.
 *
 * PENDING LIVE VERIFICATION: clerkMiddleware throws at runtime without
 * NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY; behavior must be
 * confirmed against a live Clerk instance.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk(.*)",
  "/portal(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  // Standard Next matcher: skip _next and static files, cover api routes.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
