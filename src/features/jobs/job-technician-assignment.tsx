"use client";

/** Accessible dispatch controls. Server actions remain the authorization boundary. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { assignJobTechnician, setPrimaryJobTechnician, unassignJobTechnician } from "./server/job.actions";

export interface AssignedJobTechnician {
  technicianId: string;
  name: string;
  employeeCode: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface EligibleJobTechnician { id: string; name: string; employeeCode: string | null; }

export function JobTechnicianAssignment({
  jobId, assigned, eligible, canAssign,
}: { jobId: string; assigned: AssignedJobTechnician[]; eligible: EligibleJobTechnician[]; canAssign: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const assignedIds = new Set(assigned.map((item) => item.technicianId));
  const available = eligible.filter((item) => !assignedIds.has(item.id));

  async function execute(label: string, action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setPending(label); setMessage(null);
    const result = await action();
    if (result.ok) { setIsError(false); setMessage("Dispatch assignment saved."); router.refresh(); }
    else { setIsError(true); setMessage(result.error?.message ?? "Unable to save dispatch assignment."); }
    setPending(null);
  }

  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">A job can have any number of assigned technicians and zero or one primary technician. Assigning or promoting a primary automatically demotes the prior primary.</p>
    {message && <p aria-live="polite" className={`text-sm ${isError ? "text-destructive" : "text-emerald-700"}`}>{message}</p>}
    {assigned.length === 0 ? <p className="text-sm text-muted-foreground">No technicians assigned.</p> : <ul className="space-y-2" aria-label="Assigned technicians">
      {assigned.map((item) => <li key={item.technicianId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
        <span className="font-medium">{item.name}{item.employeeCode ? <span className="ml-1 text-muted-foreground">· {item.employeeCode}</span> : null}{item.isPrimary ? <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Primary</span> : null}{!item.isActive ? <span className="ml-2 text-xs text-muted-foreground">Inactive</span> : null}</span>
        {canAssign && <span className="flex gap-2">
          {!item.isPrimary && <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => execute(`primary-${item.technicianId}`, () => setPrimaryJobTechnician({ jobId, technicianId: item.technicianId }) as ReturnType<typeof assignJobTechnician>)}>{pending === `primary-${item.technicianId}` ? "Saving…" : "Make primary"}</Button>}
          <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => execute(`remove-${item.technicianId}`, () => unassignJobTechnician({ jobId, technicianId: item.technicianId }) as ReturnType<typeof assignJobTechnician>)}>{pending === `remove-${item.technicianId}` ? "Removing…" : "Unassign"}</Button>
        </span>}
      </li>)}
    </ul>}
    {canAssign && <div className="flex flex-wrap items-end gap-2 border-t pt-4">
      <label className="min-w-56 flex-1 text-xs font-medium text-muted-foreground">Add active technician
        <select value={selected} onChange={(event) => setSelected(event.target.value)} className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground">
          <option value="">Select technician</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}{item.employeeCode ? ` · ${item.employeeCode}` : ""}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={!selected || pending !== null} onClick={() => execute("assign", () => assignJobTechnician({ jobId, technicianId: selected }))}>{pending === "assign" ? "Assigning…" : "Assign"}</Button>
    </div>}
  </div>;
}
