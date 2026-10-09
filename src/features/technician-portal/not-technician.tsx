/**
 * Shared empty state for the technician portal pages (P2-S5): the signed-in
 * user holds the portal's read permissions but has no (active) Technician
 * record in this organization, so there is nothing scoped to show. Server-safe
 * (no "use client").
 */
export function NotATechnician({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <div className="mt-6 rounded-xl border bg-card p-8 text-center">
        <p className="font-medium">You are not set up as a technician in this organization.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an owner or admin to add you under Technicians to see your schedule, jobs and time entries.
        </p>
      </div>
    </div>
  );
}
