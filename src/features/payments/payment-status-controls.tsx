"use client";
/** Ledger lifecycle controls: void/refund come from a server-derived allowed-next set; server rechecks. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PaymentStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { refundPayment, voidPayment } from "./server/payment.actions";
import { paymentStatusLabel } from "@/server/domain/payment-status";
import type { PaymentRowAction } from "./payment-ui";
export function PaymentStatusControls({ paymentId, currentStatus, actions }: { paymentId: string; currentStatus: PaymentStatus; actions: PaymentRowAction[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PaymentStatus | null>(null);
  async function transition(action: PaymentRowAction) {
    setPending(action.status);
    setError(null);
    const result = action.status === "REFUNDED" ? await refundPayment({ id: paymentId }) : await voidPayment({ id: paymentId });
    if (result.ok) router.refresh();
    else setError(result.error.message);
    setPending(null);
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Current: {paymentStatusLabel(currentStatus)}</span>
      {actions.map((action) => <Button key={action.status} type="button" size="sm" variant={action.destructive ? "destructive" : "outline"} disabled={pending !== null} onClick={() => transition(action)}>{pending === action.status ? "Updating…" : action.label}</Button>)}
      {actions.length === 0 && <span className="text-xs text-muted-foreground">Terminal — this ledger entry can no longer change.</span>}
    </div>
    {error && <p className="text-sm text-destructive">{error}</p>}
  </div>;
}
