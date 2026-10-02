"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import type { Permission, Role } from "@prisma/client";

const NAV_ITEMS: readonly { href: string; label: string; permission: Permission }[] = [
  { href: "", label: "Dashboard", permission: "DASHBOARD_READ" },
  { href: "customers", label: "Customers", permission: "CUSTOMER_READ" },
  { href: "leads", label: "Leads", permission: "LEAD_READ" },
  { href: "schedule", label: "Schedule", permission: "SCHEDULE_READ" },
  { href: "jobs", label: "Jobs", permission: "JOB_READ" },
  { href: "estimates", label: "Estimates", permission: "ESTIMATE_READ" },
  { href: "invoices", label: "Invoices", permission: "INVOICE_READ" },
  { href: "settings", label: "Settings", permission: "ORGANIZATION_READ" },
  { href: "settings/members", label: "Members", permission: "MEMBERS_READ" },
];

export function OrgShell({ organizationName, orgSlug, userEmail, role, permissions, children }: {
  organizationName: string; orgSlug: string; userEmail: string; role: Role;
  permissions: readonly Permission[]; children: React.ReactNode;
}) {
  const pathname = usePathname();
  const can = (permission: Permission) => permissions.includes(permission);
  return <div className="flex min-h-screen bg-muted/20">
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-background md:flex">
      <div className="flex h-16 items-center border-b px-5"><Link href={`/${orgSlug}`} className="text-lg font-bold tracking-tight">Field<span className="text-primary">Flow</span></Link></div>
      <div className="border-b p-3"><OrganizationSwitcher hidePersonal={true} afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" /></div>
      <nav className="flex flex-1 flex-col gap-1 p-3">{NAV_ITEMS.filter((item) => can(item.permission)).map((item) => {
        const href = `/${orgSlug}${item.href ? `/${item.href}` : ""}`;
        const active = item.href ? pathname.startsWith(href) : pathname === href;
        return <Link key={item.href} href={href} className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{item.label}</Link>;
      })}</nav>
      <div className="border-t p-4 text-xs text-muted-foreground"><p className="truncate font-semibold text-foreground">{organizationName}</p><p className="truncate">{userEmail}</p><p className="mt-1 uppercase tracking-wide">{role.replaceAll("_", " ")}</p></div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col"><header className="flex h-16 items-center justify-between border-b bg-background px-4 md:justify-end"><Link href={`/${orgSlug}`} className="font-bold md:hidden">Field<span className="text-primary">Flow</span></Link><div className="flex items-center gap-3"><span className="hidden text-sm text-muted-foreground sm:inline">{organizationName}</span><UserButton /></div></header><main className="flex-1 p-4 md:p-8">{children}</main></div>
  </div>;
}
