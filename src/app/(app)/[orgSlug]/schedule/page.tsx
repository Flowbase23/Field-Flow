import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { PlaceholderCard } from "@/components/layout/placeholder-card";

/**
 * Schedule — placeholder. Appointment model, technician assignment, calendar
 * views and conflict detection are Phase 1 Slice 4.
 */
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  await requirePermission(Permission.SCHEDULE_READ);
  return <PlaceholderCard title="Schedule" target="Slice 4 (Scheduling & calendar)" />;
}
