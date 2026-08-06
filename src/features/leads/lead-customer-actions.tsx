"use client";
/**
 * Lead ↔ customer association (Phase 1, Slice 3): attach an existing customer
 * to a lead, and convert a WON lead into a customer (minimal — creates the
 * customer, links it, audits; the first-job placeholder lands in Slice 5).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { attachCustomerToLead, convertWonLead } from "./server/lead.actions";

export interface CustomerOption {
  id: string;
  name: string;
}

export function LeadCustomerActions({
  leadId,
  status,
  hasCustomer,
  customers,
  orgSlug,
}: {
  leadId: string;
  status: string;
  hasCustomer: boolean;
  customers: CustomerOption[];
  orgSlug: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"attach" | "convert" | null>(null);

  async function onAttach() {
    if (!customerId) return;
    setPending("attach");
    setError(null);
    const res = await attachCustomerToLead({ id: leadId, customerId });
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPending(null);
  }

  async function onConvert() {
    if (!confirm("Convert this won lead into a customer? A customer record is created and linked to this lead.")) return;
    setPending("convert");
    setError(null);
    const res = await convertWonLead({ id: leadId });
    if (res.ok) {
      router.push(`/${orgSlug}/customers/${res.data.customerId}`);
      router.refresh();
    } else {
      setError(res.error.message);
      setPending(null);
    }
  }

  if (hasCustomer) {
    return (
      <p className="text-sm text-muted-foreground">
        Linked to a customer — this lead will not be converted again.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {customers.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-52 flex-1">
            <span className="text-xs font-medium text-muted-foreground">Existing customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="">Select a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" size="sm" variant="outline" disabled={!customerId || pending !== null} onClick={onAttach}>
            {pending === "attach" ? "…" : "Link to this customer"}
          </Button>
        </div>
      )}
      {status === "WON" && (
        <div className="rounded-lg border border-green-600/30 bg-green-50 p-3 text-sm text-green-800">
          <p className="font-medium">This lead is won — convert it into a customer.</p>
          <p className="mt-1 text-xs">
            Creates a customer record from the lead and links it. A first job placeholder arrives with the Jobs slice (Phase 1, Slice 5).
          </p>
          <Button type="button" size="sm" className="mt-2" disabled={pending !== null} onClick={onConvert}>
            {pending === "convert" ? "Converting…" : "Convert to customer"}
          </Button>
        </div>
      )}
    </div>
  );
}
