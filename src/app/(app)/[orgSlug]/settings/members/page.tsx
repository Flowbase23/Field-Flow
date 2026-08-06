import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { db } from "@/server/db/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export default async function MembersPage() {
  const ctx = await requirePermission(Permission.MEMBERS_READ);
  const members = await db.membership.findMany({ where: { organizationId: ctx.organizationId }, include: { user: true }, orderBy: { createdAt: "asc" } });
  return <div className="mx-auto max-w-4xl space-y-6"><div><h1 className="text-3xl font-bold">Members</h1><p className="text-muted-foreground">Manage access to {ctx.organization.name}.</p></div><Card><CardHeader><CardTitle>{members.length} member{members.length === 1 ? "" : "s"}</CardTitle></CardHeader><CardContent className="space-y-3">{members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-medium">{member.user.email}</p><p className="text-xs text-muted-foreground">{member.role.replaceAll("_", " ")}</p></div><span className={`rounded-full px-2 py-1 text-xs ${member.isActive ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}`}>{member.isActive ? "Active" : "Inactive"}</span></div>)}{members.length === 0 && <p className="text-sm text-muted-foreground">No members found.</p>}</CardContent></Card><p className="text-xs text-muted-foreground">Invitations and role/status mutations are credential-gated and will be enabled with Clerk live keys. Self-role changes and self-deactivation are always blocked.</p></div>;
}
