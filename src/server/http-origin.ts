/**
 * The absolute origin the current request came in on — the shared helper for
 * building absolute URLs server-side (Stripe requires absolute success/cancel
 * URLs, and portal link copies need a full URL to hand to the customer).
 *
 * Derived from the request's Host/x-forwarded headers — the same server-side
 * trust level the rest of the app uses; never client-supplied in a payload.
 * Empty string when no Host header exists (non-HTTP contexts), which callers
 * must treat as a failure (see the checkout actions).
 */
import { headers } from "next/headers";

export async function requestOrigin(): Promise<string> {
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host");
  if (!host) return "";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
