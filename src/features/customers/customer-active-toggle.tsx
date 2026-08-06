"use client";
/**
 * Row action for the customers list + detail header: deactivate (soft delete,
 * gated by CUSTOMER_DELETE) / reactivate (gated by CUSTOMER_UPDATE). Records
 * are never hard-deleted (repo convention). The server action re-checks the
 * permission and audits STATUS_CHANGED.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setCustomerActive } from "./server/customer.actions";

export function CustomerActiveToggle({
  customerId,
  isActive,
  canDeactivate,
  canActivate,
}: {
  customerId: string;
  isActive: boolean;
  canDeactivate: boolean;
  canActivate: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isActive && !canDeactivate) return null;
  if (!isActive && !canActivate) return null;

  async function onToggle() {
    setPending(true);
    setError(null);
    const res = await setCustomerActive({ id: customerId, isActive: !isActive });
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error.message);
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        type="button"
        size="sm"
        variant={isActive ? "outline" : "secondary"}
        onClick={onToggle}
        disabled={pending}
      >
        {pending ? "…" : isActive ? "Deactivate" : "Reactivate"}
      </Button>
    </span>
  );
}
