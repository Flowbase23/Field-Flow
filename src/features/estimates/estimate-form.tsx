"use client";
/**
 * Create/edit estimate form. Customer and job choices are supplied by a
 * tenant-scoped page; the browser sends money only as integer cents parsed from
 * plain strings. The total shown here is the client's preview — the server
 * recomputes and stores its own value.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createEstimate, updateEstimate } from "./server/estimate.actions";
import { estimateCreateSchema, estimateUpdateActionSchema } from "./schemas";
import { centsToInput, formatIntegerCents, moneyInputToCents } from "@/lib/money";

export interface EstimateCustomerOption {
  id: string;
  name: string;
}
export interface EstimateJobOption {
  id: string;
  customerId: string;
  label: string;
}
export interface EstimateFormInitial {
  customerId: string;
  jobId: string | null;
  title: string | null;
  validUntil: string | null;
  subtotalCents: number;
  taxCents: number;
}
const inputClass = "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";
function dateToInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
export function EstimateForm({
  mode, orgSlug, estimateId, initial, customers, jobs, currency,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  estimateId?: string;
  initial?: EstimateFormInitial;
  customers: EstimateCustomerOption[];
  jobs: EstimateJobOption[];
  currency: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(initial?.customerId ?? customers[0]?.id ?? "");
  const [jobId, setJobId] = useState(initial?.jobId ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [validUntil, setValidUntil] = useState(dateToInput(initial?.validUntil ?? null));
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
      title: title || null,
      validUntil: validUntil || null,
      subtotalCents: subtotalCents ?? 0,
      taxCents: taxCents ?? 0,
    };
    const result = mode === "create"
      ? await createEstimate(estimateCreateSchema.parse(payload))
      : await updateEstimate(estimateUpdateActionSchema.parse({ id: estimateId, ...payload }));
    if (result.ok) {
      router.push(`/${orgSlug}/estimates/${result.data.id}`);
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
      <label className="md:col-span-2">
        <span className={labelClass}>Title (optional)</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Furnace replacement — 2-stage 80k BTU" className={inputClass} />
      </label>
      <label>
        <span className={labelClass}>Valid until</span>
        <input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className={inputClass} />
      </label>
      <span />
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
      total = subtotal + tax; amounts entered here never set the total directly.
    </p>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <Button type="button" onClick={submit} disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Create estimate" : "Save changes"}</Button>
  </div>;
}
