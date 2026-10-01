"use client";
/**
 * Create/edit invoice form. Customer and job choices are supplied by a
 * tenant-scoped page; the browser sends money only as integer cents parsed from
 * plain strings. Totals/balances shown here are the client's preview — the
 * server recomputes and stores its own values.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createInvoice, updateInvoice } from "./server/invoice.actions";
import { invoiceCreateSchema, invoiceUpdateActionSchema } from "./schemas";
import { centsToInput, formatIntegerCents, moneyInputToCents } from "@/lib/money";

export interface InvoiceCustomerOption {
  id: string;
  name: string;
}
export interface InvoiceJobOption {
  id: string;
  customerId: string;
  label: string;
}
export interface InvoiceFormInitial {
  customerId: string;
  jobId: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  subtotalCents: number;
  taxCents: number;
}
const inputClass = "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";
function dateToInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
export function InvoiceForm({
  mode, orgSlug, invoiceId, initial, customers, jobs, currency,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  invoiceId?: string;
  initial?: InvoiceFormInitial;
  customers: InvoiceCustomerOption[];
  jobs: InvoiceJobOption[];
  currency: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(initial?.customerId ?? customers[0]?.id ?? "");
  const [jobId, setJobId] = useState(initial?.jobId ?? "");
  const [issuedAt, setIssuedAt] = useState(dateToInput(initial?.issuedAt ?? null));
  const [dueAt, setDueAt] = useState(dateToInput(initial?.dueAt ?? null));
  const [subtotal, setSubtotal] = useState(centsToInput(initial?.subtotalCents ?? 0));
  const [tax, setTax] = useState(centsToInput(initial?.taxCents ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const subtotalCents = moneyInputToCents(subtotal);
  const taxCents = moneyInputToCents(tax);
  const previewCents = subtotalCents !== undefined && taxCents !== undefined ? (subtotalCents ?? 0) + (taxCents ?? 0) : null;
  const customerJobs = jobs.filter((job) => job.customerId === customerId);
  async function submit() {
    setPending(true);
    setError(null);
    if (subtotalCents === undefined || taxCents === undefined) {
      setError("Enter money as whole dollars or dollars and cents (for example, 1250.00).");
      setPending(false);
      return;
    }
    if (!customerId) {
      setError("Select a customer.");
      setPending(false);
      return;
    }
    const payload = {
      customerId,
      jobId: jobId || null,
      issuedAt: issuedAt || null,
      dueAt: dueAt || null,
      subtotalCents: subtotalCents ?? 0,
      taxCents: taxCents ?? 0,
    };
    const result = mode === "create"
      ? await createInvoice(invoiceCreateSchema.parse(payload))
      : await updateInvoice(invoiceUpdateActionSchema.parse({ id: invoiceId, ...payload }));
    if (result.ok) {
      router.push(`/${orgSlug}/invoices/${result.data.id}`);
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }
  return <div className="space-y-4 rounded-lg border bg-card p-4">
    <div className="grid gap-4 md:grid-cols-2">
      <label>
        <span className={labelClass}>Customer</span>
        <select value={customerId} onChange={(event) => { setCustomerId(event.target.value); setJobId(""); }} className={inputClass}>
          <option value="">Select a customer…</option>
          {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select>
      </label>
      <label>
        <span className={labelClass}>Linked job (optional)</span>
        <select value={jobId ?? ""} onChange={(event) => setJobId(event.target.value)} className={inputClass} disabled={customerJobs.length === 0}>
          <option value="">No linked job</option>
          {customerJobs.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
        </select>
        {customerJobs.length === 0 && <span className="mt-1 block text-xs text-muted-foreground">No jobs for this customer yet.</span>}
      </label>
      <label>
        <span className={labelClass}>Issue date</span>
        <input type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} className={inputClass} />
      </label>
      <label>
        <span className={labelClass}>Due date</span>
        <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className={inputClass} />
      </label>
      <label>
        <span className={labelClass}>Subtotal</span>
        <input inputMode="decimal" value={subtotal} onChange={(event) => setSubtotal(event.target.value)} className={inputClass} />
      </label>
      <label>
        <span className={labelClass}>Tax</span>
        <input inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} className={inputClass} />
      </label>
    </div>
    <p className="text-sm text-muted-foreground">
      Total preview: {previewCents !== null ? formatIntegerCents(previewCents, currency) : "—"} — the server stores
      total = subtotal + tax and balance = total − paid; amounts entered here never set the balance.
    </p>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <Button type="button" onClick={submit} disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Create invoice" : "Save changes"}</Button>
  </div>;
}
