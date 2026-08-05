"use client";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the org shell. ForbiddenError (403) from requireOrg /
 * requirePermission / requireRole lands here with its message.
 */
export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-2xl font-semibold">Something went wrong</h2>
      <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
      <Button variant="outline" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
