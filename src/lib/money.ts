/**
 * Money helpers. All monetary amounts are stored as integer cents
 * (design §3 "Schema notes": money in integer cents) — never floats.
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let fmt = formatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, fmt);
  }
  return fmt;
}

/** "12345" cents → "$123.45" (in `currency`, default USD). */
export function formatMoney(cents: number, currency = "USD"): string {
  return formatter(currency).format(cents / 100);
}

/** "$123.45" input (as number) → 12345 cents. Rounding is banker-safe via Math.round. */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error("dollarsToCents: input must be finite.");
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}
