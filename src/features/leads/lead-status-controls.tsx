"use client";
/**
 * Lead status controls (Phase 1, Slice 3): shows the current status and a
 * button per ALLOWED next status (computed server-side from the pipeline map).
 * LOST prompts for a reason. The server action re-enforces the transition map.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { updateLeadStatus } from "./server/lead.actions";

export function LeadStatusControls({
  leadId,
  currentStatus,
  allowedNext,
}: {
  leadId: string;
  currentStatus: string;
  allowedNext: string[];
}) {
  const router = useRouter();
  const [lostReason, setLostReason] = useState("");
  const [showLostInput, setShowLostInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function onTransition(status: string) {
    if (status === "LOST" && !showLostInput) {
      setShowLostInput(true);
      return;
    }
    setPending(status);
    setError(null);
    const res = await updateLeadStatus({ id: leadId, status, lostReason: status === "LOST" ? lostReason : null });
    if (res.ok) {
      setShowLostInput(false);
      setLostReason("");
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPending(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Current: {currentStatus}</span>
        {allowedNext.map((status) => (
          <Button key={status} type="button" size="sm" variant="outline" disabled={pending !== null} onClick={() => onTransition(status)}>
            {pending === status ? "…" : `→ ${status.charAt(0) + status.slice(1).toLowerCase()}`}
          </Button>
        ))}
        {allowedNext.length === 0 && <span className="text-xs text-muted-foreground">(terminal — no further transitions)</span>}
      </div>
      {showLostInput && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="Why is this lead lost?"
            className="h-9 w-full max-w-sm rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Button type="button" size="sm" variant="destructive" disabled={pending !== null || !lostReason.trim()} onClick={() => onTransition("LOST")}>
            Confirm lost
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
