import { SignUp } from "@clerk/nextjs";

/**
 * Clerk-hosted sign-up. PENDING LIVE VERIFICATION: same credential
 * requirements as /sign-in.
 */
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return <SignUp />;
}
