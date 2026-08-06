import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const ctx = await requirePermission(Permission.ORGANIZATION_READ);
  return <div className="mx-auto max-w-3xl space-y-6"><div><h1 className="text-3xl font-bold">Organization settings</h1><p className="text-muted-foreground">Defaults used across your FieldFlow workspace.</p></div><Card><CardHeader><CardTitle>Workspace details</CardTitle><CardDescription>Only administrators can update these values.</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2"><div><p className="text-sm font-medium">Organization name</p><p className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">{ctx.organization.name}</p></div><div><p className="text-sm font-medium">Slug</p><p className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{ctx.organization.slug}</p></div><div><p className="text-sm font-medium">Timezone</p><p className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">{ctx.organization.timezone}</p></div><div><p className="text-sm font-medium">Currency</p><p className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">{ctx.organization.currency}</p></div></CardContent></Card></div>;
}
