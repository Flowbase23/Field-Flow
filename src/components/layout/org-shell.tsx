import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import type { Role } from "@prisma/client";

const NAV_ITEMS = [
  { href: "", label: "Dashboard" },
  { href: "customers", label: "Customers" },
  { href: "leads", label: "Leads" },
  { href: "schedule", label: "Schedule" },
  { href: "jobs", label: "Jobs" },
  { href: "settings", label: "Settings" },
] as const;

/**
 * Org shell: sidebar navigation + Clerk user menu (org switcher).
 * Server component — nav links are derived from the org slug in the URL;
 * per-route permission checks happen in each page via requirePermission.
 */
export function OrgShell({
  organizationName,
  orgSlug,
  userEmail,
  role,
  children,
}: {
  organizationName: string;
  orgSlug: string;
  userEmail: string;
  role: Role;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex h-14 items-center border-b px-4">
          <Link href={`/${orgSlug}`} className="text-base font-semibold tracking-tight">
            FieldFlow
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3 text-sm">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              href={`/${orgSlug}/${item.href}`}
              className="rounded-md px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <p className="truncate font-medium text-foreground">{organizationName}</p>
          <p className="truncate">{userEmail}</p>
          <p className="mt-1 uppercase tracking-wide">{role}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end border-b px-4">
          <UserButton />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
