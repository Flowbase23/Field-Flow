/**
 * Layout for the PUBLIC customer portal (Slice P2-S4): tokenized pages under
 * /portal/* that never require a Clerk session. Deliberately minimal chrome —
 * no sign-in/sign-up links, no app navigation — so a customer who opened a
 * link sees only their own document.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-6">
          <span className="text-lg font-semibold tracking-tight">Customer portal</span>
          <span className="text-xs text-muted-foreground">Secure link · no account needed</span>
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-6 py-12">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        Powered by FieldFlow
      </footer>
    </div>
  );
}
