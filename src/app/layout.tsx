import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "@/styles/globals.css";

/**
 * Root layout: ClerkProvider wraps the whole app (Clerk is the identity provider
 * for the platform; local Organization/User/Membership rows are synced by the
 * webhook in src/app/api/webhooks/clerk/route.ts).
 *
 * force-dynamic: every route is server-rendered per request so that Clerk and
 * requireOrg() can run — nothing is statically prerendered (this also keeps
 * `next build` from evaluating Clerk/DB code without credentials).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "FieldFlow",
    template: "%s · FieldFlow",
  },
  description:
    "FieldFlow — the all-in-one field service platform for HVAC, plumbing, and electrical companies.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
