/**
 * Integer-cent display/input helpers for jobs.
 *
 * The implementation now lives in src/lib/money.ts (shared with the invoice
 * feature); these re-exports keep the existing job imports stable.
 */
export { formatIntegerCents, centsToInput, moneyInputToCents } from "@/lib/money";
