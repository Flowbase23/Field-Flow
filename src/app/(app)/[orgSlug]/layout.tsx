import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { UnauthorizedError } from "@/lib/errors";
import { OrgShell } from "@/components/layout/org-shell";
import { Providers } from "@/components/providers";

/**
 * Org-scoped app shell.
 *
 * The tenant identity comes exclusively from requireOrg() (Clerk session org);
 * the `orgSlug` URL segment is cosmetic — if it doesn't match the session org's
 * slug we redirect to the canonical URL. Never look up data by orgSlug.
 */
export const dynamic = "force-dynamic";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  let ctx;
  try {
    ctx = await requireOrg();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect("/sign-in");
    }
    // ForbiddenError and unexpected errors surface in the nearest error boundary.
    throw err;
  }

  if (ctx.organization.slug !== orgSlug) {
    redirect(`/${ctx.organization.slug}`);
  }
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);

  return (
    <Providers>
      <OrgShell
        organizationName={ctx.organization.name}
        orgSlug={ctx.organization.slug}
        userEmail={ctx.user.email}
        role={ctx.membership.role}
        permissions={permissions}
      >
        {children}
      </OrgShell>
    </Providers>
  );
}
