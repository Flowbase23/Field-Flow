"use client";
/**
 * Location manager — add / edit / delete locations for a customer (Phase 1,
 * Slice 3). Nested in the customer detail page. Add+edit are gated by
 * CUSTOMER_UPDATE, delete by CUSTOMER_DELETE (passed in from the server page —
 * defense in depth: the server actions re-check). All mutations go through the
 * audited server actions and the page re-fetches via router.refresh().
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createLocation, deleteLocation, updateLocation } from "./server/location.actions";

export interface LocationRow {
  id: string;
  label: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  timezone: string | null;
  accessNotes: string | null;
}

interface FormState {
  label: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  timezone: string;
  accessNotes: string;
}

function emptyForm(label = "Primary"): FormState {
  return { label, address1: "", address2: "", city: "", state: "", postalCode: "", country: "US", timezone: "", accessNotes: "" };
}

function toForm(loc: LocationRow): FormState {
  return {
    label: loc.label,
    address1: loc.address1,
    address2: loc.address2 ?? "",
    city: loc.city,
    state: loc.state,
    postalCode: loc.postalCode,
    country: loc.country,
    timezone: loc.timezone ?? "",
    accessNotes: loc.accessNotes ?? "",
  };
}

const inputClass =
  "h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "block text-xs font-medium text-muted-foreground";

function LocationFields({ form, onChange }: { form: FormState; onChange: (next: FormState) => void }) {
  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...form, [key]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={labelClass}>
        Label
        <input className={inputClass} value={form.label} onChange={set("label")} placeholder="Primary" />
      </label>
      <label className={labelClass}>
        Country
        <input className={inputClass} value={form.country} onChange={set("country")} placeholder="US" />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        Street address
        <input className={inputClass} value={form.address1} onChange={set("address1")} placeholder="123 Main St" />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        Address line 2 (optional)
        <input className={inputClass} value={form.address2} onChange={set("address2")} placeholder="Suite 200" />
      </label>
      <label className={labelClass}>
        City
        <input className={inputClass} value={form.city} onChange={set("city")} placeholder="Raleigh" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={labelClass}>
          State
          <input className={inputClass} value={form.state} onChange={set("state")} placeholder="NC" />
        </label>
        <label className={labelClass}>
          Postal code
          <input className={inputClass} value={form.postalCode} onChange={set("postalCode")} placeholder="27601" />
        </label>
      </div>
      <label className={labelClass}>
        Timezone (IANA, optional)
        <input className={inputClass} value={form.timezone} onChange={set("timezone")} placeholder="America/New_York" />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        Access notes (gate codes, parking…)
        <textarea className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" rows={2} value={form.accessNotes} onChange={set("accessNotes")} />
      </label>
    </div>
  );
}

export function LocationManager({
  customerId,
  orgSlug,
  locations,
  canManage,
  canDelete,
}: {
  customerId: string;
  orgSlug: string;
  locations: LocationRow[];
  canManage: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent, mode: "add" | "edit") {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res =
      mode === "add"
        ? await createLocation({ customerId, ...form })
        : await updateLocation({ id: editingId!, ...form });
    if (res.ok) {
      setShowAdd(false);
      setEditingId(null);
      setForm(emptyForm());
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPending(false);
  }

  async function remove(id: string) {
    if (!confirm("Delete this location? This cannot be undone.")) return;
    setError(null);
    const res = await deleteLocation({ id });
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error.message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Locations</CardTitle>
            <CardDescription>Service addresses for this customer.</CardDescription>
          </div>
          {canManage && !showAdd && (
            <Button type="button" size="sm" variant="outline" onClick={() => { setShowAdd(true); setEditingId(null); setForm(emptyForm()); }}>
              Add location
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        {showAdd && (
          <form onSubmit={(e) => submit(e, "add")} className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">New location</p>
            <LocationFields form={form} onChange={setForm} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Add location"}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            </div>
          </form>
        )}

        {locations.length === 0 && !showAdd ? (
          <p className="text-sm text-muted-foreground">No locations yet.</p>
        ) : (
          <ul className="space-y-3">
            {locations.map((loc) => (
              <li key={loc.id} className="rounded-lg border p-4">
                {editingId === loc.id ? (
                  <form onSubmit={(e) => submit(e, "edit")} className="space-y-3">
                    <LocationFields form={form} onChange={setForm} />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-sm">
                      <p className="font-medium">
                        {loc.label}
                        {loc.timezone ? <span className="ml-2 text-xs text-muted-foreground">{loc.timezone}</span> : null}
                      </p>
                      <p className="text-muted-foreground">
                        {[loc.address1, loc.address2, `${loc.city}, ${loc.state} ${loc.postalCode}`, loc.country]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                      {loc.accessNotes ? <p className="mt-1 text-xs text-muted-foreground">Notes: {loc.accessNotes}</p> : null}
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => { setEditingId(loc.id); setForm(toForm(loc)); setError(null); }}>
                          Edit
                        </Button>
                        {canDelete && (
                          <Button type="button" size="sm" variant="destructive" onClick={() => remove(loc.id)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
