import Link from "next/link";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { customerLabel } from "@/features/technician-portal/technician-portal-ui";
import { NotATechnician } from "@/features/technician-portal/not-technician";

/**
 * Technician jobs view (P2-S5): ONLY the jobs the signed-in technician is
 * assigned to (JobTechnician join, technicianId = self resolved server-side).
 * Detail: field-relevant data only — customer, service address, status — not
 * the org-wide job desk. The org-wide /jobs stays for staff roles.
 */
export const dynamic = "force-dynamic";

export default async function MyJobsPage() {
  const ctx = await requirePermission(Permission.JOB_READ);
  const repos = tenantDb(ctx.organizationId);
  const self = await repos.technicians.getByUserId(ctx.userId);
  if (!self) return <NotATechnician title="My Jobs" />;
  const jobs = await repos.jobs.listForTechnician(self.id);
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">My Jobs</h1>
        <p className="mt-1 text-muted-foreground">{ctx.organization.name} · jobs assigned to you</p>
      </div>
      {jobs.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No jobs assigned to you yet.</div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <Link key={job.id} href={`/${ctx.organization.slug}/my-jobs/${job.id}`} className="block rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">#{job.jobNumber} · {job.title}</p>
                <p className="text-sm text-muted-foreground">{job.status.replace(/_/g, " ").toLowerCase()} · {job.priority.toLowerCase()}</p>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {customerLabel(job.customer)}
                {job.location ? ` · ${[job.location.city, job.location.state].filter(Boolean).join(", ")}` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
