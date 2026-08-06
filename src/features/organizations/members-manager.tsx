/**
 * MembersManager — client UI for the Members page (Slice 2 follow-up).
 *
 * Server page passes permission-aware props (canManage is computed server-side
 * from the caller's effective permissions via can()/permissionsFor); this
 * component hides the invite form and disables role/status controls when the
 * caller lacks MEMBERS_MANAGE, and always disables self-mutation (the server
 * actions re-enforce both rules via requirePermission + canChangeMembership).
 *
 * All mutations call the server actions and surface ActionResult errors
 * inline; on success the page is refreshed (router.refresh) so the list shows
 * the new role/status.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { changeRole, inviteMember, setMemberActive } from "./server/members.actions";
import { MEMBERSHIP_ROLES, type MembershipRole } from "./schemas";

const ROLE_LABELS: Record<MembershipRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  OFFICE_STAFF: "Office staff",
  DISPATCHER: "Dispatcher",
  TECHNICIAN: "Technician",
  SALES_REP: "Sales rep",
  CUSTOMER_PORTAL_USER: "Customer portal",
};

export interface MemberRow {
  id: string;
  userId: string;
  role: MembershipRole;
  isActive: boolean;
  email: string;
}

export interface MembersManagerProps {
  organizationName: string;
  currentUserId: string;
  canManage: boolean;
  members: MemberRow[];
}

export function MembersManager({
  organizationName,
  currentUserId,
  canManage,
  members,
}: MembersManagerProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MembershipRole>("OFFICE_STAFF");
  const [inviting, setInviting] = useState(false);

  const isSelf = (userId: string) => userId === currentUserId;
  const rowLocked = (userId: string) => !canManage || isSelf(userId);

  async function onRoleChange(member: MemberRow, role: MembershipRole) {
    if (rowLocked(member.userId)) return;
    setPendingId(member.id);
    setError(null);
    setNotice(null);
    const res = await changeRole({ membershipId: member.id, role });
    if (res.ok) {
      setNotice(`Role for ${member.email} updated.`);
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPendingId(null);
  }

  async function onToggleActive(member: MemberRow) {
    if (rowLocked(member.userId)) return;
    setPendingId(member.id);
    setError(null);
    setNotice(null);
    const res = await setMemberActive({ membershipId: member.id, isActive: !member.isActive });
    if (res.ok) {
      setNotice(res.data.isActive ? `${member.email} is now active.` : `${member.email} deactivated.`);
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setPendingId(null);
  }

  async function onSubmitInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    const res = await inviteMember({ email: inviteEmail, role: inviteRole });
    if (res.ok) {
      setInviteEmail("");
      setNotice(`Invitation sent to ${res.data.email}.`);
      router.refresh();
    } else {
      setError(res.error.message);
    }
    setInviting(false);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Members</h1>
        <p className="text-muted-foreground">Manage access to {organizationName}.</p>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg border border-green-600/30 bg-green-50 px-3 py-2 text-sm text-green-800">
          {notice}
        </p>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a member</CardTitle>
            <CardDescription>
              An email invitation is sent through Clerk. The invitee becomes a member once they
              accept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmitInvite} className="flex flex-wrap items-end gap-3">
              <label className="min-w-56 flex-1">
                <span className="text-xs font-medium text-muted-foreground">Email</span>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="tech@example.com"
                  className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </label>
              <label>
                <span className="text-xs font-medium text-muted-foreground">Role</span>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as MembershipRole)}
                  className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {MEMBERSHIP_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={inviting}>
                {inviting ? "Sending…" : "Send invite"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {members.length} member{members.length === 1 ? "" : "s"}
          </CardTitle>
          {!canManage && (
            <CardDescription>You can view members but not manage them.</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {members.map((member) => {
            const locked = rowLocked(member.userId);
            const pending = pendingId === member.id;
            return (
              <div
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-40">
                  <p className="font-medium">
                    {member.email}
                    {isSelf(member.userId) && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  {locked && isSelf(member.userId) && (
                    <p className="text-xs text-muted-foreground">
                      You can’t change your own role or status.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <label>
                    <span className="sr-only">Role for {member.email}</span>
                    <select
                      value={member.role}
                      disabled={locked || pending}
                      title={locked ? (isSelf(member.userId) ? "You can’t change your own role." : "Requires member management permission.") : undefined}
                      onChange={(e) => onRoleChange(member, e.target.value as MembershipRole)}
                      className="h-9 rounded-lg border bg-background px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {MEMBERSHIP_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    variant={member.isActive ? "outline" : "secondary"}
                    size="sm"
                    disabled={locked || pending}
                    title={
                      isSelf(member.userId)
                        ? "You can’t deactivate your own membership."
                        : undefined
                    }
                    onClick={() => onToggleActive(member)}
                  >
                    {pending ? "Saving…" : member.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <span
                    className={`rounded-full px-2 py-1 text-xs ${
                      member.isActive ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {member.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            );
          })}
          {members.length === 0 && <p className="text-sm text-muted-foreground">No members found.</p>}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Invitations are sent through Clerk and require live Clerk keys (PENDING LIVE VERIFICATION).
        Role and status changes apply to the FieldFlow workspace immediately; self-role changes and
        self-deactivation are always blocked.
      </p>
    </div>
  );
}
