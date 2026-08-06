"use client";
/**
 * Appointment detail popover (Phase 1, Slice 4): shows the appointment and
 * offers status actions computed from the SERVER-ENFORCED transition map
 * (appointment-transitions.ts), plus Mark missed and Cancel. The server action
 * re-enforces every transition; the UI just offers the allowed set.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { APPOINTMENT_TRANSITIONS } from "@/server/domain/appointment-transitions";
import {
  STATUS_LABELS,
  TYPE_LABELS,
  statusChipClass,
  statusDotClass,
  typeChipClass,
  chipTimeLabel,
  type SerializedAppointment,
} from "./calendar";
import { cancelAppointment, markAppointmentMissed, setAppointmentStatus } from "./server/appointment.actions";

export function AppointmentDetail({
  appointment,
  timezone,
  canUpdate,
  canDelete,
  onEdit,
}: {
  appointment: SerializedAppointment;
  timezone: string;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: (appt: SerializedAppointment) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = appointment.status;

  const allowed = APPOINTMENT_TRANSITIONS[status as keyof typeof APPOINTMENT_TRANSITIONS] ?? [];
  const transitionTargets = allowed.filter((s) => s !== "CANCELLED" && s !== "MISSED");
  const canMarkMissed = allowed.includes("MISSED");
  const canCancel = allowed.includes("CANCELLED");
  const terminal = allowed.length === 0;

  async function run(action: "status" | "missed" | "cancel", target?: string) {
    setPending(target ?? action);
    setError(null);
    const res =
      action === "cancel"
        ? await cancelAppointment({ id: appointment.id })
        : action === "missed"
          ? await markAppointmentMissed({ id: appointment.id })
          : await setAppointmentStatus({ id: appointment.id, status: target! });
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPending(null);
  }

  return (
    <PopoverRoot>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={`w-full truncate rounded border px-1.5 py-0.5 text-left text-xs font-medium shadow-sm transition-colors hover:brightness-95 ${statusChipClass(status)}`}
          >
            {chipTimeLabel(appointment.startsAt, appointment.timezone)} {appointment.title}
          </button>
        }
      />
      <PopoverContent>
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${statusDotClass(status)}`} />
              <h3 className="text-sm font-semibold">{appointment.title}</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {chipTimeLabel(appointment.startsAt, appointment.timezone)} – {chipTimeLabel(appointment.endsAt, appointment.timezone)} ({appointment.timezone})
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className={`rounded-full px-2 py-0.5 font-medium ${statusChipClass(status)}`}>{STATUS_LABELS[status] ?? status}</span>
            <span className={`rounded-full px-2 py-0.5 font-medium ${typeChipClass(appointment.type)}`}>{TYPE_LABELS[appointment.type] ?? appointment.type}</span>
            {appointment.travelMinutesBefore > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{appointment.travelMinutesBefore}m before</span>}
            {appointment.travelMinutesAfter > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{appointment.travelMinutesAfter}m after</span>}
          </div>
          {appointment.technicianNames.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Technicians:</span> {appointment.technicianNames.join(", ")}
            </p>
          )}
          {(appointment.jobTitle || appointment.locationLabel) && (
            <p className="text-xs text-muted-foreground">
              {appointment.jobTitle && <span>Job: {appointment.jobTitle}</span>}
              {appointment.jobTitle && appointment.locationLabel && <span> · </span>}
              {appointment.locationLabel && <span>At: {appointment.locationLabel}</span>}
            </p>
          )}
          {appointment.notes && <p className="text-xs text-muted-foreground">{appointment.notes}</p>}

          {error && <p className="text-xs text-destructive">{error}</p>}

          {canUpdate && !terminal && (
            <div className="flex flex-wrap gap-1.5 border-t pt-2">
              {transitionTargets.map((target) => (
                <Button key={target} type="button" size="sm" variant="outline" disabled={pending !== null} onClick={() => run("status", target)}>
                  {pending === target ? "…" : `→ ${STATUS_LABELS[target] ?? target}`}
                </Button>
              ))}
              {canMarkMissed && (
                <Button type="button" size="sm" variant="outline" className="text-rose-700" disabled={pending !== null} onClick={() => run("missed")}>
                  {pending === "missed" ? "…" : "Mark missed"}
                </Button>
              )}
              {canCancel && (
                <Button type="button" size="sm" variant="destructive" disabled={pending !== null} onClick={() => run("cancel")}>
                  {pending === "cancel" ? "…" : "Cancel"}
                </Button>
              )}
            </div>
          )}
          {terminal && <p className="text-xs text-muted-foreground border-t pt-2">Final status — no further changes.</p>}
          {canUpdate && (
            <Button type="button" size="sm" variant="ghost" className="w-full" onClick={() => onEdit(appointment)}>
              Edit…
            </Button>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
