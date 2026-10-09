"use client";
/**
 * "Log time" form for the technician portal (P2-S5). Manual hours OR an
 * optional start/end wall-clock pair (decisions documented in the slice PR —
 * no live clock timer UI in this slice). The server derives the stored minutes
 * from the inputs and enforces positivity/span rules; this form only shapes
 * the payload and surfaces typed ActionResult errors.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { logTimeEntry } from "./server/time-entry.actions";

const inputClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm";

export function TimeEntryForm({ jobs, today }: { jobs: readonly { id: string; label: string }[]; today: string }) {
  const router = useRouter();
  const [jobId, setJobId] = useState("");
  const [workDate, setWorkDate] = useState(today);
  const [mode, setMode] = useState<"hours" | "span">("hours");
  const [hours, setHours] = useState("1");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [billable, setBillable] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await logTimeEntry({
      jobId: jobId || null,
      workDate,
      ...(mode === "hours" ? { hours: Number(hours) } : { startTime, endTime }),
      billable,
    });
    if (result.ok) {
      setBillable(false);
      setMode("hours");
      setHours("1");
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="font-semibold">Log time</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted-foreground">Date</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="text-sm">
          <span className="text-muted-foreground">Job (optional)</span>
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} className={`mt-1 ${inputClass}`}>
            <option value="">General time (no job)</option>
            {jobs.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
          </select>
        </label>
        <div className="text-sm sm:col-span-2">
          <span className="text-muted-foreground">Duration</span>
          <div className="mt-1 flex gap-2">
            <Button type="button" size="sm" variant={mode === "hours" ? "default" : "outline"} onClick={() => setMode("hours")}>Hours</Button>
            <Button type="button" size="sm" variant={mode === "span" ? "default" : "outline"} onClick={() => setMode("span")}>Start / end</Button>
          </div>
        </div>
        {mode === "hours" ? (
          <label className="text-sm">
            <span className="text-muted-foreground">Hours worked</span>
            <input type="number" min="0.25" max="24" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
        ) : (
          <>
            <label className="text-sm">
              <span className="text-muted-foreground">Start</span>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={`mt-1 ${inputClass}`} />
            </label>
            <label className="text-sm">
              <span className="text-muted-foreground">End</span>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={`mt-1 ${inputClass}`} />
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
          <span className="text-muted-foreground">Billable time</span>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save entry"}</Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
