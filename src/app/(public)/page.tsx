import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Application root. The product marketing/positioning lives on the public site;
 * this page is a minimal app entry that routes to authentication.
 */
export default function HomePage() {
  return (
    <section className="mx-auto w-full max-w-2xl px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">FieldFlow</h1>
      <p className="mt-4 text-lg text-muted-foreground">
        The all-in-one platform for HVAC, plumbing, and electrical companies —
        customers, scheduling, jobs, invoicing, and reporting in one place.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        The FieldFlow app is in private beta and under active development.
      </p>
      <div className="mt-8 flex items-center justify-center gap-3">
        <Button render={<Link href="/sign-in" />}>Sign in</Button>
        <Button variant="outline" render={<Link href="/sign-up" />}>
          Create account
        </Button>
      </div>
    </section>
  );
}
