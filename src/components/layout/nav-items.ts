/**
 * Navigation items + visibility rule, extracted from org-shell so the filter
 * logic is unit-testable (tests/technician-portal). An item is visible when
 * the user holds its permission AND satisfies its optional role constraint:
 * `onlyRoles` = technician-portal views (technicians get scoped "My …" views
 * instead of the org-wide ones), `notRoles` = org-wide views that would expose
 * other technicians' records to a technician (product decision, P2-S5 —
 * office/admin/dispatcher keep the full views).
 */
import type { Permission, Role } from "@prisma/client";

export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  onlyRoles?: readonly Role[];
  notRoles?: readonly Role[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "", label: "Dashboard", permission: "DASHBOARD_READ" },
  { href: "customers", label: "Customers", permission: "CUSTOMER_READ" },
  { href: "leads", label: "Leads", permission: "LEAD_READ" },
  { href: "schedule", label: "Schedule", permission: "SCHEDULE_READ", notRoles: ["TECHNICIAN"] },
  { href: "jobs", label: "Jobs", permission: "JOB_READ", notRoles: ["TECHNICIAN"] },
  { href: "my-schedule", label: "My Schedule", permission: "SCHEDULE_READ", onlyRoles: ["TECHNICIAN"] },
  { href: "my-jobs", label: "My Jobs", permission: "JOB_READ", onlyRoles: ["TECHNICIAN"] },
  { href: "my-time", label: "My Time", permission: "TIME_READ", onlyRoles: ["TECHNICIAN"] },
  { href: "estimates", label: "Estimates", permission: "ESTIMATE_READ" },
  { href: "invoices", label: "Invoices", permission: "INVOICE_READ" },
  { href: "payments", label: "Payments", permission: "PAYMENT_READ" },
  { href: "settings", label: "Settings", permission: "ORGANIZATION_READ" },
  { href: "settings/members", label: "Members", permission: "MEMBERS_READ" },
];

export function visibleNavItems(
  items: readonly NavItem[],
  permissions: readonly Permission[],
  role: Role,
): readonly NavItem[] {
  return items.filter(
    (item) =>
      permissions.includes(item.permission) &&
      (!item.onlyRoles || item.onlyRoles.includes(role)) &&
      (!item.notRoles || !item.notRoles.includes(role)),
  );
}
