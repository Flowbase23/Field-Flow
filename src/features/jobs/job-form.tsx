"use client";
/** Create/edit job form. Customer/location choices are supplied by a tenant-scoped page. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { JOB_PRIORITIES, JOB_TYPES, jobCreateSchema, jobUpdateActionSchema } from "./schemas";
import { createJob, updateJob } from "./server/job.actions";
import { centsToInput, moneyInputToCents } from "./job-money";
import { jobPriorityLabel, jobTypeLabel } from "./job-ui";

export interface JobCustomerOption {
  id: string;
  name: string;
  locations: { id: string; label: string; address: string }[];
}

export interface JobFormInitial {
  customerId: string;
  /** Nullable since the P2-2 follow-up: converted jobs can start location-less. */
  locationId: string | null;
  title: string;
  type: string;
  priority: string;
  description: string | null;
  quotedAmountCents: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  actualRevenueCents: number | null;
}

const inputClass = "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";

export function JobForm({
  mode, orgSlug, jobId, initial, customers, currency,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  jobId?: string;
  initial?: JobFormInitial;
  customers: JobCustomerOption[];
  currency: string;
}) {
  const router = useRouter();
  const initialCustomerId = initial?.customerId ?? customers[0]?.id ?? "";
  const initialCustomer = customers.find((customer) => customer.id === initialCustomerId);
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [locationId, setLocationId] = useState(initial?.locationId ?? initialCustomer?.locations[0]?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [type, setType] = useState(initial?.type ?? "SERVICE_CALL");
  const [priority, setPriority] = useState(initial?.priority ?? "NORMAL");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [quotedAmount, setQuotedAmount] = useState(centsToInput(initial?.quotedAmountCents ?? null));
  const [subtotal, setSubtotal] = useState(centsToInput(initial?.subtotalCents ?? 0));
  const [tax, setTax] = useState(centsToInput(initial?.taxCents ?? 0));
  const [total, setTotal] = useState(centsToInput(initial?.totalCents ?? 0));
  const [actualRevenue, setActualRevenue] = useState(centsToInput(initial?.actualRevenueCents ?? null));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedCustomer = customers.find((customer) => customer.id === customerId);

  function selectCustomer(nextCustomerId: string) {
    const customer = customers.find((item) => item.id === nextCustomerId);
    setCustomerId(nextCustomerId);
    // Never keep a location from the prior customer in the browser payload.
    setLocationId(customer?.locations[0]?.id ?? "");
  }

  function parseMoney(): { quotedAmountCents: number | null; subtotalCents: number; taxCents: number; totalCents: number; actualRevenueCents: number | null } | null {
    const quotedAmountCents = moneyInputToCents(quotedAmount);
    const subtotalCents = moneyInputToCents(subtotal);
    const taxCents = moneyInputToCents(tax);
    const totalCents = moneyInputToCents(total);
    const actualRevenueCents = moneyInputToCents(actualRevenue);
    if (quotedAmountCents === undefined || subtotalCents === undefined || taxCents === undefined || totalCents === undefined || actualRevenueCents === undefined) {
      setError("Enter money as whole dollars or dollars and cents (for example, 1250.00).");
      return null;
    }
    return {
      quotedAmountCents,
      subtotalCents: subtotalCents ?? 0,
      taxCents: taxCents ?? 0,
      totalCents: totalCents ?? 0,
      actualRevenueCents,
    };
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const money = parseMoney();
    if (!money) return;
    if (!customerId || !locationId) {
      setError("Select a customer and one of that customer’s locations.");
      return;
    }
    const payload = { customerId, locationId, title, type, priority, description, ...money };
    const parsed = mode === "create"
      ? jobCreateSchema.safeParse(payload)
      : jobUpdateActionSchema.safeParse({ id: jobId!, ...payload });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form and try again.");
      return;
    }

    setPending(true);
    const result = mode === "create" ? await createJob(payload) : await updateJob({ id: jobId!, ...payload });
    if (result.ok) {
      router.push(`/${orgSlug}/jobs/${result.data.id}`);
      router.refresh();
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }

  if (customers.length === 0) {
    return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Create a customer with a service location before creating a job.</p>;
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-5">
      {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Customer</span>
          <select value={customerId} onChange={(event) => selectCustomer(event.target.value)} className={inputClass}>
            {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
          </select>
        </label>
        <label>
          <span className={labelClass}>Service location</span>
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)} className={inputClass} disabled={!selectedCustomer?.locations.length}>
            {!selectedCustomer?.locations.length && <option value="">No locations for this customer</option>}
            {selectedCustomer?.locations.map((location) => <option key={location.id} value={location.id}>{location.label} — {location.address}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={labelClass}>Job title</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} placeholder="Repair rooftop unit" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value)} className={inputClass}>
            {JOB_TYPES.map((value) => <option key={value} value={value}>{jobTypeLabel(value)}</option>)}
          </select>
        </label>
        <label>
          <span className={labelClass}>Priority</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value)} className={inputClass}>
            {JOB_PRIORITIES.map((value) => <option key={value} value={value}>{jobPriorityLabel(value)}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={labelClass}>Description</span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="Scope, access notes, requested work…" />
      </label>
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Amounts</legend>
        <p className="text-xs text-muted-foreground">Enter dollars and cents. Amounts are stored as integer cents; this does not create an invoice or payment.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyField label={`Quoted amount (${currency})`} value={quotedAmount} onChange={setQuotedAmount} />
          <MoneyField label={`Actual revenue (${currency})`} value={actualRevenue} onChange={setActualRevenue} />
          <MoneyField label={`Subtotal (${currency})`} value={subtotal} onChange={setSubtotal} required />
          <MoneyField label={`Tax (${currency})`} value={tax} onChange={setTax} required />
          <MoneyField label={`Total (${currency})`} value={total} onChange={setTotal} required />
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !selectedCustomer?.locations.length}>{pending ? "Saving…" : mode === "create" ? "Create job" : "Save changes"}</Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}

function MoneyField({ label, value, onChange, required = false }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return <label><span className={labelClass}>{label} ($)</span><input inputMode="decimal" required={required} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} placeholder={required ? "0.00" : "Optional"} /></label>;
}
