"use client";
/**
 * "Pay now" control on the PUBLIC invoice portal page. The action creates the
 * PENDING ledger row (audited) and returns the Stripe-hosted checkout URL for
 * the server-read balance; the browser leaves the app for card entry and the
 * existing P2-3 webhook reconciles the ledger when Stripe confirms.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { startInvoiceCheckoutByPortalToken } from "./server/portal.actions";

export function InvoicePortalPayButton({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pay() {
    setPending(true);
    setError(null);
    const result = await startInvoiceCheckoutByPortalToken({ token });
    if (result.ok) {
      // Stripe hosts the card entry — leave the app entirely.
      window.location.assign(result.data.url);
      return;
    }
    setError(result.error.message);
    setPending(false);
  }
  return <div className="inline-flex flex-col items-start gap-1">
    <Button type="button" size="sm" disabled={pending} onClick={pay}>
      {pending ? "Opening checkout…" : "Pay now with card"}
    </Button>
    <p className="text-xs text-muted-foreground">Checkout is hosted securely by Stripe. You will return here afterwards.</p>
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>;
}
