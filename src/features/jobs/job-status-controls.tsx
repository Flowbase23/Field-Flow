"use client";
/** Lifecycle controls: actions come from a server-derived allowed-next set; server rechecks. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { JobStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { setJobStatus } from "./server/job.actions";
import type { JobStatusAction } from "./job-ui";

export function JobStatusControls({ jobId, currentStatus, actions }: { jobId: string; currentStatus: JobStatus; actions: JobStatusAction[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<JobStatus | null>(null);

  async function transition(status: JobStatus) {
    setPending(status);
    setError(null);
    const result = await setJobStatus({ id: jobId, status });
    if (result.ok) router.refresh();
    else setError(result.error.message);
    setPending(null);
  }

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Current: {currentStatus.replaceAll("_", " ")}</span>
      {actions.map((action) => <Button key={action.status} type="button" size="sm" variant={action.destructive ? "destructive" : "outline"} disabled={pending !== null} onClick={() => transition(action.status)}>{pending === action.status ? "Updating…" : action.label}</Button>)}
      {actions.length === 0 && <span className="text-xs text-muted-foreground">Terminal — no further lifecycle changes.</span>}
    </div>
    {error && <p className="text-sm text-destructive">{error}</p>}
  </div>;
}
