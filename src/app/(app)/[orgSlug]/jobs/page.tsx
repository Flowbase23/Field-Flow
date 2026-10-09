import Link from "next/link";
import { redirect } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { Button, buttonVariants } from "@/components/ui/button";
import { JOB_PRIORITIES, JOB_STATUSES } from "@/features/jobs/schemas";
import { jobPriorityLabel, jobStatusLabel, jobTypeLabel, parseJobListFilters } from "@/features/jobs/job-ui";
import { formatDateInTz } from "@/lib/dates";

/** Tenant-scoped jobs work-order list. Filtering is URL-backed and server rendered. */
export const dynamic = "force-dynamic";
const PAGE_SIZE = 25;

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string; priority?: string; page?: string }> }) {
  const ctx = await requirePermission(Permission.JOB_READ);
  // P2-S5: technicians get their OWN jobs (my-jobs) — the org-wide job desk
  // would expose jobs assigned to other technicians.
  if (ctx.membership.role === "TECHNICIAN") {
    redirect(`/${ctx.organization.slug}/my-jobs`);
  }
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;
  const filters = parseJobListFilters(sp);
  const page = Math.max(1, Number(sp.page) || 1);
  const repo = tenantDb(ctx.organizationId).jobs;
  const [jobs, total] = await Promise.all([
    repo.list({ ...filters, page, pageSize: PAGE_SIZE }),
    repo.count(filters),
  ]);
  const canCreate = can(permissions, Permission.JOB_CREATE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (extra: Record<string, string | undefined>) => new URLSearchParams(
    Object.entries({ status: filters.status, priority: filters.priority, ...extra }).filter(([, value]) => value !== undefined) as [string, string][],
  ).toString();

  return <div className="mx-auto max-w-7xl space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Jobs</h1>
        <p className="mt-1 text-muted-foreground">{total} work order{total === 1 ? "" : "s"} in {ctx.organization.name}.</p>
      </div>
      {canCreate && <Link href={`/${ctx.organization.slug}/jobs/new`} className={buttonVariants({ variant: "default", size: "default" })}>New job</Link>}
    </div>

    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <label>
        <span className="text-xs font-medium text-muted-foreground">Status</span>
        <select name="status" defaultValue={filters.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All statuses</option>
          {JOB_STATUSES.map((status) => <option key={status} value={status}>{jobStatusLabel(status)}</option>)}
        </select>
      </label>
      <label>
        <span className="text-xs font-medium text-muted-foreground">Priority</span>
        <select name="priority" defaultValue={filters.priority ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All priorities</option>
          {JOB_PRIORITIES.map((priority) => <option key={priority} value={priority}>{jobPriorityLabel(priority)}</option>)}
        </select>
      </label>
      <Button type="submit" size="sm">Filter</Button>
      {(filters.status || filters.priority) && <Link href={`/${ctx.organization.slug}/jobs`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>}
    </form>

    {jobs.length === 0 ? <div className="rounded-lg border border-dashed p-12 text-center">
      <p className="font-medium">No jobs found</p>
      <p className="mt-1 text-sm text-muted-foreground">{filters.status || filters.priority ? "Try clearing the filters or choosing another lifecycle state." : canCreate ? "Create a job from a customer and service location to get started." : "Jobs will appear here once your team creates them."}</p>
    </div> : <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-4 py-3">Job</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Priority</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Updated</th>
        </tr></thead>
        <tbody className="divide-y">{jobs.map((job) => <tr key={job.id} className="hover:bg-muted/40">
          <td className="px-4 py-3"><Link href={`/${ctx.organization.slug}/jobs/${job.id}`} className="font-medium text-primary hover:underline">#{job.jobNumber} · {job.title}</Link></td>
          <td className="px-4 py-3">{(job.customer.companyName ?? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(" ")) || "Customer"}</td>
          <td className="px-4 py-3 text-muted-foreground">{job.location ? <><p>{job.location.label}</p><p className="text-xs">{job.location.city}, {job.location.state}</p></> : <span className="text-xs">Not set yet</span>}</td>
          <td className="px-4 py-3">{jobTypeLabel(job.type)}</td>
          <td className="px-4 py-3"><PriorityBadge priority={job.priority} /></td>
          <td className="px-4 py-3"><span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{jobStatusLabel(job.status)}</span></td>
          <td className="px-4 py-3 text-muted-foreground">{formatDateInTz(job.updatedAt, ctx.organization.timezone, "short")}</td>
        </tr>)}</tbody>
      </table>
    </div>}

    {totalPages > 1 && <div className="flex items-center justify-between text-sm"><p className="text-muted-foreground">Page {page} of {totalPages}</p><div className="flex gap-2">
      {page > 1 && <Link href={`/${ctx.organization.slug}/jobs?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>}
      {page < totalPages && <Link href={`/${ctx.organization.slug}/jobs?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>}
    </div></div>}
  </div>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const classes: Record<string, string> = { LOW: "bg-muted text-muted-foreground", NORMAL: "bg-blue-100 text-blue-800", HIGH: "bg-amber-100 text-amber-800", URGENT: "bg-red-100 text-red-800" };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[priority] ?? "bg-muted"}`}>{jobPriorityLabel(priority)}</span>;
}
