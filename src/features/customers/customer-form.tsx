"use client";
/**
 * Customer create/edit form (Phase 1, Slice 3).
 *
 * Plain controlled form (same pattern as members-manager) calling the server
 * actions directly; the shared Zod schemas (features/customers/schemas.ts) are
 * used for client-side feedback, and the server re-validates. The duplicate
 * policy surfaces as a 409 ConflictError banner: "A customer ... already
 * exists ... link instead of creating a duplicate."
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CUSTOMER_TYPES, customerCreateSchema, customerUpdateSchema } from "./schemas";
import { createCustomer, updateCustomer } from "./server/customer.actions";
import type { CustomerType } from "@prisma/client";

export interface CustomerFormInitial {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  type: CustomerType;
  notes: string | null;
}

export function CustomerForm({
  mode,
  orgSlug,
  customerId,
  initial,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  customerId?: string;
  initial?: CustomerFormInitial;
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initial?.firstName ?? "");
  const [lastName, setLastName] = useState(initial?.lastName ?? "");
  const [companyName, setCompanyName] = useState(initial?.companyName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [type, setType] = useState<CustomerType>(initial?.type ?? "RESIDENTIAL");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const inputClass =
    "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const labelClass = "text-xs font-medium text-muted-foreground";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const payload = { firstName, lastName, companyName, email, phone, type, notes };
    // Client-side validation for instant feedback (server re-validates).
    const schema = mode === "create" ? customerCreateSchema : customerUpdateSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form and try again.");
      setPending(false);
      return;
    }

    const res =
      mode === "create"
        ? await createCustomer(payload)
        : await updateCustomer({ id: customerId!, ...payload });

    if (res.ok) {
      router.push(`/${orgSlug}/customers/${res.data.id}`);
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
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>First name</span>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputClass} placeholder="Jane" />
        </label>
        <label>
          <span className={labelClass}>Last name</span>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputClass} placeholder="Doe" />
        </label>
      </div>
      <label className="block">
        <span className={labelClass}>Company name</span>
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className={inputClass} placeholder="Acme Plumbing" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="jane@acme.com" />
        </label>
        <label>
          <span className={labelClass}>Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="(555) 123-4567" />
        </label>
      </div>
      <label className="block">
        <span className={labelClass}>Type</span>
        <select value={type} onChange={(e) => setType(e.target.value as CustomerType)} className={inputClass}>
          {CUSTOMER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0) + t.slice(1).toLowerCase().replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="Gate codes, preferences, history…" />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create customer" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
