/** Integer-cent display/input helpers for jobs. No decimal floating point is used. */

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
