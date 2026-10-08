"use client";
/**
 * Accept/Decline controls on the PUBLIC estimate portal page. The token is the
 * only input — the customer is anonymous and every guard is re-checked
 * server-side (acceptEstimateByPortalToken / declineEstimateByPortalToken).
 * After a decision the server page refetches and renders the recorded outcome.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptEstimateByPortalToken, declineEstimateByPortalToken } from "./server/portal.actions";

export function EstimatePortalDecision({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"ACCEPTED" | "DECLINED" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "ACCEPTED" | "DECLINED") {
    setPending(decision);
    setError(null);
    const result = decision === "ACCEPTED"
      ? await acceptEstimateByPortalToken({ token })
      : await declineEstimateByPortalToken({ token });
    if (result.ok) {
      router.refresh();
      return;
    }
    setError(result.error.message);
    setPending(null);
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" disabled={pending !== null} onClick={() => decide("ACCEPTED")}>
        {pending === "ACCEPTED" ? "Recording…" : "Accept estimate"}
      </Button>
      <Button type="button" variant="outline" disabled={pending !== null} onClick={() => decide("DECLINED")}>
        {pending === "DECLINED" ? "Recording…" : "Decline estimate"}
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">Your decision is recorded once and cannot be changed from this page afterwards.</p>
    {error && <p className="text-sm text-destructive">{error}</p>}
  </div>;
}
