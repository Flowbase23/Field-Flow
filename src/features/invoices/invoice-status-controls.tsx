"use client";
/** Lifecycle controls: actions come from a server-derived allowed-next set; server rechecks. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { setInvoiceStatus } from "./server/invoice.actions";
import type { InvoiceStatusAction } from "./invoice-ui";
export function InvoiceStatusControls({ invoiceId, currentStatus, actions }: { invoiceId: string; currentStatus: InvoiceStatus; actions: InvoiceStatusAction[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<InvoiceStatus | null>(null);
  async function transition(status: InvoiceStatus) {
    setPending(status);
    setError(null);
    const result = await setInvoiceStatus({ id: invoiceId, status });
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
