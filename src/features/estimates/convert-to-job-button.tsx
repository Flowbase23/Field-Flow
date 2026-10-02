"use client";
/**
 * Convert-to-job control for the estimate detail page. The page only renders
 * this for an ACCEPTED estimate without an existing conversion and only for
 * callers holding JOB_CREATE; the server action independently re-checks both.
 *
 * On success the component links straight to the new job AND refreshes, so the
 * page re-renders into its "converted" state (the server-side marker on the
 * job keeps the button from ever reappearing for this estimate).
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { convertEstimateToJob } from "./server/estimate.actions";

export function ConvertToJobButton({ estimateId, orgSlug }: { estimateId: string; orgSlug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ jobId: string; jobNumber: number } | null>(null);

  async function convert() {
    setPending(true);
    setError(null);
    const result = await convertEstimateToJob({ id: estimateId });
    if (result.ok) {
      setCreated({ jobId: result.data.jobId, jobNumber: result.data.jobNumber });
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  if (created) {
    return (
      <p className="text-sm">
        <span className="text-green-700">Converted to </span>
        <Link href={`/${orgSlug}/jobs/${created.jobId}`} className="font-medium text-primary hover:underline">
          Job #{created.jobNumber}
        </Link>
        <span className="text-muted-foreground"> — it now appears under Jobs as a draft work order.</span>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={convert}>
          {pending ? "Converting…" : "Convert to job"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Creates a draft job from this estimate: customer, amounts and the next org-local job number. Technicians and
          the service location (when ambiguous) are filled in afterwards.
        </span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
