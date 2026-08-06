"use client";
/**
 * Appointment create/edit form (Phase 1, Slice 4) — RHF + Zod per the stack.
 *
 * Times are entered as wall-clock datetimes (datetime-local) in an explicit
 * IANA timezone (default: the org timezone). The server converts to UTC for
 * storage and back for display. Conflict errors from the server action surface
 * inline with the exact conflicting appointment; the allow-overlap override is
 * only shown to callers who hold SCHEDULE_UPDATE (Dispatcher/Admin).
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { DialogRoot, DialogContent, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { utcToLocalDateTime } from "@/lib/dates";
import { COMMON_TIMEZONES } from "@/features/organizations/schemas";
import { APPOINTMENT_TYPES, appointmentCreateSchema, appointmentUpdateActionSchema } from "./schemas";
import type { SerializedAppointment, SerializedTechnician } from "./calendar";
import { createAppointment, updateAppointment } from "./server/appointment.actions";

const inputClass =
  "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60";
const labelClass = "text-xs font-medium text-muted-foreground";

export interface AppointmentFormInitial {
  id?: string; // present in edit mode
  title: string;
  type: string;
  startsAt: string; // UTC ISO
  endsAt: string; // UTC ISO
  timezone: string;
  technicianIds: string[];
  jobId: string | null;
  locationId: string | null;
  travelMinutesBefore: number;
  travelMinutesAfter: number;
  notes: string | null;
}

export function AppointmentForm({
  orgSlug,
  initial,
  technicians,
  locations,
  jobs,
  showAllowOverlap,
}: {
  orgSlug: string;
  /** When provided (id set) the form edits; otherwise it creates. */
  initial?: AppointmentFormInitial;
  technicians: SerializedTechnician[];
  locations: { id: string; label: string }[];
  /** Jobs arrive in Slice 5 — the select is ready but empty until then. */
  jobs: { id: string; title: string }[];
  showAllowOverlap: boolean;
}) {
  const router = useRouter();
  const mode = initial?.id ? "edit" : "create";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const defaultValues = useMemo(() => {
    if (initial?.id) {
      return {
        title: initial.title,
        type: initial.type,
        startsAt: utcToLocalDateTime(new Date(initial.startsAt), initial.timezone),
        endsAt: utcToLocalDateTime(new Date(initial.endsAt), initial.timezone),
        timezone: initial.timezone,
        technicianIds: initial.technicianIds,
        jobId: initial.jobId ?? "",
        locationId: initial.locationId ?? "",
        travelMinutesBefore: initial.travelMinutesBefore,
        travelMinutesAfter: initial.travelMinutesAfter,
        notes: initial.notes ?? "",
        allowOverlap: false,
      };
    }
    return {
      title: "",
      type: "JOB",
      startsAt: initial ? utcToLocalDateTime(new Date(initial.startsAt), initial.timezone) : "",
      endsAt: initial ? utcToLocalDateTime(new Date(initial.endsAt), initial.timezone) : "",
      timezone: initial?.timezone ?? "America/New_York",
      technicianIds: [] as string[],
      jobId: "",
      locationId: "",
      travelMinutesBefore: 0,
      travelMinutesAfter: 0,
      notes: "",
      allowOverlap: false,
    };
  }, [initial]);

  const schema = mode === "create" ? appointmentCreateSchema : appointmentUpdateActionSchema;
  const form = useForm({
    resolver: zodResolver(schema as never),
    defaultValues: defaultValues as never,
  });

  const { register, control, handleSubmit, formState } = form;

  async function onSubmit(values: Record<string, unknown>) {
    setPending(true);
    setError(null);
    const payload = {
      ...values,
      jobId: values.jobId ? String(values.jobId) : null,
      locationId: values.locationId ? String(values.locationId) : null,
      technicianIds: Array.isArray(values.technicianIds) ? values.technicianIds : [],
      travelMinutesBefore: Number(values.travelMinutesBefore ?? 0),
      travelMinutesAfter: Number(values.travelMinutesAfter ?? 0),
      allowOverlap: Boolean(values.allowOverlap),
    };
    const res =
      mode === "create"
        ? await createAppointment(payload)
        : await updateAppointment({ id: initial!.id, ...payload });
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPending(false);
  }

  return (
    <DialogRoot defaultOpen onOpenChange={() => undefined}>
      <DialogContent>
        <DialogTitle>{mode === "create" ? "New appointment" : "Edit appointment"}</DialogTitle>
        <DialogDescription>
          Times are {mode === "create" ? "entered" : "shown"} in the appointment timezone and stored as UTC.
        </DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <label className="block">
            <span className={labelClass}>Title</span>
            <input {...register("title")} className={inputClass} placeholder="Replace water heater" />
            {formState.errors.title && <span className="text-xs text-destructive">{String(formState.errors.title.message)}</span>}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={labelClass}>Type</span>
              <select {...register("type")} className={inputClass}>
                {APPOINTMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0) + t.slice(1).toLowerCase().replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelClass}>Timezone</span>
              <select {...register("timezone")} className={inputClass}>
                {[initial?.timezone, "America/New_York", ...COMMON_TIMEZONES]
                  .filter((tz, i, arr) => typeof tz === "string" && arr.indexOf(tz) === i)
                  .map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={labelClass}>Starts</span>
              <input type="datetime-local" {...register("startsAt")} className={inputClass} />
              {formState.errors.startsAt && <span className="text-xs text-destructive">{String(formState.errors.startsAt.message)}</span>}
            </label>
            <label>
              <span className={labelClass}>Ends</span>
              <input type="datetime-local" {...register("endsAt")} className={inputClass} />
              {formState.errors.endsAt && <span className="text-xs text-destructive">{String(formState.errors.endsAt.message)}</span>}
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={labelClass}>Travel before (min)</span>
              <input type="number" min={0} max={720} {...register("travelMinutesBefore")} className={inputClass} />
            </label>
            <label>
              <span className={labelClass}>Travel after (min)</span>
              <input type="number" min={0} max={720} {...register("travelMinutesAfter")} className={inputClass} />
            </label>
          </div>
          <div>
            <span className={labelClass}>Technicians</span>
            <Controller
              control={control}
              name="technicianIds"
              render={({ field }) => (
                <div className="mt-1 flex flex-wrap gap-2">
                  {technicians.length === 0 && <span className="text-sm text-muted-foreground">No active technicians yet.</span>}
                  {technicians.map((tech) => {
                    const checked = (field.value as string[]).includes(tech.id);
                    return (
                      <label
                        key={tech.id}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                          checked ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={() =>
                            field.onChange(
                              checked
                                ? (field.value as string[]).filter((id) => id !== tech.id)
                                : [...(field.value as string[]), tech.id],
                            )
                          }
                        />
                        {tech.name}
                      </label>
                    );
                  })}
                </div>
              )}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={labelClass}>Linked job</span>
              <select {...register("jobId")} className={inputClass}>
                <option value="">None</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title}
                  </option>
                ))}
              </select>
              {jobs.length === 0 && <span className="text-xs text-muted-foreground">Jobs arrive in the next slice.</span>}
            </label>
            <label>
              <span className={labelClass}>Location</span>
              <select {...register("locationId")} className={inputClass}>
                <option value="">None</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className={labelClass}>Notes</span>
            <textarea {...register("notes")} rows={3} className={inputClass} placeholder="Access notes, scope, contacts…" />
          </label>
          {showAllowOverlap && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("allowOverlap")} className="h-4 w-4 rounded border" />
              Allow overlap with existing appointments (override conflict detection)
            </label>
          )}
          <div className="flex items-center justify-end gap-3 pt-1">
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : mode === "create" ? "Create appointment" : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
