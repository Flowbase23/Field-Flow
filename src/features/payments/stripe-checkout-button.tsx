"use client";
/**
 * "Pay with Stripe" button on the invoice detail page. Renders only when the
 * server reports Stripe as configured (the key itself never reaches the
 * client). The action creates the PENDING ledger row and returns the hosted
 * checkout URL; the browser is redirected there.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { startStripeCheckout } from "./server/payment.actions";
export function StripeCheckoutButton({ invoiceId, label = "Pay with Stripe" }: { invoiceId: string; label?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function open() {
    setPending(true);
    setError(null);
    const result = await startStripeCheckout({ invoiceId });
    if (result.ok) {
      // Stripe hosts the card entry — leave the app entirely.
      window.location.assign(result.data.url);
      return;
    }
    setError(result.error.message);
    setPending(false);
  }
  return <div className="inline-flex flex-col items-start gap-1">
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={open}>{pending ? "Opening checkout…" : label}</Button>
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>;
}
