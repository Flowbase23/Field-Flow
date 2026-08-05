import Link from "next/link";

/**
 * Layout for unauthenticated routes: "/", "/sign-in", "/sign-up".
 * The public marketing site lives in the separate `site` app; these pages are
 * the FieldFlow application's entry points.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            FieldFlow
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/sign-in" className="text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Link href="/sign-up" className="text-muted-foreground hover:text-foreground">
              Create account
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center py-16">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        FieldFlow · private beta
      </footer>
    </div>
  );
}
