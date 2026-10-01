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

// ─── Integer-only helpers (form inputs and currency-prefixed display) ────────
// These never go through Number()/float math: money leaves the browser as
// integer cents parsed from plain strings, and screens display a fixed-width
// currency-prefixed value so trailing zeros are preserved.

/** Formats cents using an explicit ISO currency prefix (e.g. `USD 1,234.56`). */
export function formatIntegerCents(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const digits = Math.abs(cents).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${sign}${whole}.${digits.slice(-2)}`;
}

/** Turns an integer cents value into a stable form value such as `123.45`. */
export function centsToInput(cents: number | null): string {
  if (cents === null) return "";
  const digits = Math.abs(cents).toString().padStart(3, "0");
  return `${cents < 0 ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Parses an optional non-negative money string directly to cents, without Number(). */
export function moneyInputToCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return undefined;
  const whole = match[1];
  const fractional = (match[2] ?? "").padEnd(2, "0");
  const cents = Number(`${whole}${fractional}`);
  if (!Number.isSafeInteger(cents)) return undefined;
  return cents;
}
