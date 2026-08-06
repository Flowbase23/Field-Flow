"use client";
/**
 * Lead create/edit form (Phase 1, Slice 3).
 *
 * Plain controlled form calling the server actions; shared Zod schemas
 * (features/leads/schemas.ts) give instant client feedback and the server
 * re-validates. Owner (sales rep) and customer options come from the server
 * page (org members + active customers). Estimated value is entered in dollars
 * and stored as integer cents (design §3: money never floats).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LEAD_SOURCES, LEAD_STATUSES, leadCreateSchema, leadUpdateActionSchema } from "./schemas";
import { createLead, updateLead } from "./server/lead.actions";
import { dollarsToCents } from "@/lib/money";

export interface LeadOption {
  id: string;
  name: string;
}

export interface LeadFormInitial {
  title: string;
  description: string | null;
  source: string;
  status: string;
  estimatedValueCents: number | null;
  ownerUserId: string | null;
  customerId: string | null;
}

const inputClass =
  "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";

export function LeadForm({
  mode,
  orgSlug,
  leadId,
  initial,
  members,
  customers,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  leadId?: string;
  initial?: LeadFormInitial;
  members: LeadOption[];
  customers: LeadOption[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [source, setSource] = useState(initial?.source ?? "OTHER");
  const [status, setStatus] = useState(initial?.status ?? "NEW");
  const [valueDollars, setValueDollars] = useState(
    initial?.estimatedValueCents != null ? (initial.estimatedValueCents / 100).toFixed(2) : "",
  );
  const [ownerUserId, setOwnerUserId] = useState(initial?.ownerUserId ?? "");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const estimatedValueCents = valueDollars.trim() === "" ? null : dollarsToCents(Number(valueDollars));
    const payload = {
      title,
      description,
      source,
      status,
      estimatedValueCents,
      ownerUserId: ownerUserId || null,
      customerId: customerId || null,
    };
    const schema = mode === "create" ? leadCreateSchema : leadUpdateActionSchema;
    const parsed = schema.safeParse(mode === "create" ? payload : { id: leadId!, ...payload });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form and try again.");
      setPending(false);
      return;
    }

    const res =
      mode === "create" ? await createLead(payload) : await updateLead({ id: leadId!, ...payload });

    if (res.ok) {
      router.push(`/${orgSlug}/leads/${res.data.id}`);
      router.refresh();
    } else {
      setError(res.error.message);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-5">
      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <label className="block">
        <span className={labelClass}>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} placeholder="Replace water heater" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={inputClass}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelClass}>Status (creation only; later changes go through the pipeline)</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={mode === "edit"} className={inputClass}>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Estimated value ($)</span>
          <input inputMode="decimal" value={valueDollars} onChange={(e) => setValueDollars(e.target.value)} className={inputClass} placeholder="8500.00" />
        </label>
        <label>
          <span className={labelClass}>Assigned sales rep</span>
          <select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} className={inputClass}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={labelClass}>Linked customer (optional)</span>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClass}>
          <option value="">None</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="Scope, timeline, contacts…" />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create lead" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
