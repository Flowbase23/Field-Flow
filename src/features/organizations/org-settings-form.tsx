/**
 * OrgSettingsForm — client form for the Organization settings page
 * (Slice 2 follow-up).
 *
 * The server page passes `canManage` (computed from the caller's effective
 * permissions via can()/permissionsFor). Without ORGANIZATION_UPDATE the form
 * renders read-only; with it, name/timezone/currency are editable and slug
 * stays read-only. Validation is shared with the server action (the same Zod
 * schema from schemas.ts) so field errors surface before the round-trip;
 * server-side ActionResult errors are shown after.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updateOrg } from "./server/org.actions";
import { COMMON_TIMEZONES, organizationUpdateSchema } from "./schemas";

export interface OrgSettingsFormProps {
  org: { id: string; name: string; slug: string; timezone: string; currency: string };
  canManage: boolean;
}

const inputClass =
  "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60";

export function OrgSettingsForm({ org, canManage }: OrgSettingsFormProps) {
  const router = useRouter();
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [currency, setCurrency] = useState(org.currency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    // Shared Zod schema — instant client-side validation before the round-trip.
    const parsed = organizationUpdateSchema.safeParse({ name, timezone, currency });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please fix the highlighted fields.");
      setSaving(false);
      return;
    }

    const res = await updateOrg(parsed.data);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Organization settings</h1>
        <p className="text-muted-foreground">Defaults used across your FieldFlow workspace.</p>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-lg border border-green-600/30 bg-green-50 px-3 py-2 text-sm text-green-800">
          Settings saved.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Workspace details</CardTitle>
          <CardDescription>
            {canManage
              ? "Name, timezone and currency are used as defaults across the workspace."
              : "Only users with the update-organization permission can change these values."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="text-sm font-medium">Organization name</label>
              <input
                value={name}
                disabled={!canManage}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Slug</label>
              <p className={`${inputClass} bg-muted/30 text-muted-foreground`}>{org.slug}</p>
            </div>
            <div>
              <label className="text-sm font-medium">Currency</label>
              <input
                value={currency}
                disabled={!canManage}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                placeholder="USD"
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-sm font-medium">Timezone</label>
              <input
                value={timezone}
                disabled={!canManage}
                list="ff-common-timezones"
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/New_York"
                className={inputClass}
              />
              <datalist id="ff-common-timezones">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <p className="mt-1 text-xs text-muted-foreground">
                IANA timezone, e.g. America/New_York. Used for day boundaries in the dashboard and
                schedule.
              </p>
            </div>
            {canManage && (
              <div className="sm:col-span-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
