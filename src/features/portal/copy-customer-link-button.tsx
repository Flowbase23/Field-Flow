"use client";
/**
 * "Copy customer link" control for the INTERNAL estimate/invoice detail pages
 * (Slice P2-S4). Renders nothing until clicked: the click resolves (or
 * first-generates) the record's portal token via the permission-gated server
 * action, shows the absolute URL, and copies it to the clipboard. The token is
 * never part of the page markup before that — links are shared on demand.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { revealEstimatePortalLink, revealInvoicePortalLink } from "./server/portal.actions";

export function CopyCustomerLinkButton({ kind, id }: { kind: "estimate" | "invoice"; id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function reveal() {
    setPending(true);
    setError(null);
    setCopied(false);
    const result = kind === "estimate"
      ? await revealEstimatePortalLink({ id })
      : await revealInvoicePortalLink({ id });
    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }
    setLink(result.data.url);
    setPending(false);
    try {
      await navigator.clipboard.writeText(result.data.url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied — the URL stays visible to copy by hand.
    }
    router.refresh();
  }
  return <div className="space-y-2">
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={reveal}>
      {pending ? "Preparing link…" : "Copy customer link"}
    </Button>
    {link && <div className="flex w-full max-w-xl items-center gap-2">
      <input
        readOnly
        value={link}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Customer link"
        className="h-8 w-full rounded-md border bg-muted px-2 font-mono text-xs"
      />
      <span className="whitespace-nowrap text-xs text-muted-foreground">{copied ? "Copied!" : "Copy manually if needed"}</span>
    </div>}
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>;
}
