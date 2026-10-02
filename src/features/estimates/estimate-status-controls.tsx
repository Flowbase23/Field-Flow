"use client";
/** Lifecycle controls: actions come from a server-derived allowed-next set; server rechecks. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EstimateStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { setEstimateStatus } from "./server/estimate.actions";
import type { EstimateStatusAction } from "./estimate-ui";
export function EstimateStatusControls({ estimateId, currentStatus, actions }: { estimateId: string; currentStatus: EstimateStatus; actions: EstimateStatusAction[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<EstimateStatus | null>(null);
  async function transition(status: EstimateStatus) {
    setPending(status);
    setError(null);
    const result = await setEstimateStatus({ id: estimateId, status });
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
