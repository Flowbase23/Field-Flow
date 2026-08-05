import { SignIn } from "@clerk/nextjs";

/**
 * Clerk-hosted sign-in. Rendered per-request (force-dynamic, inherited from the
 * root layout) — Clerk's UI requires the publishable key at runtime.
 *
 * PENDING LIVE VERIFICATION: needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and
 * CLERK_SECRET_KEY to render; the redirect target after sign-in is configured
 * in Clerk's dashboard (or via env redirect URLs).
 */
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return <SignIn />;
}
