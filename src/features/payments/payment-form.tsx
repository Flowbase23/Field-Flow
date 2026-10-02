"use client";
/**
 * Record-payment form (manual entry). The invoice list is supplied by a
 * tenant-scoped page — only invoices that can still receive money. Money is
 * sent as integer cents parsed from a plain string; the amount shown here is
 * the client's preview, the repository re-verifies the balance server-side and
 * recomputes the invoice's paid/balance from its own totals.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { recordPayment } from "./server/payment.actions";
import { paymentRecordSchema } from "./schemas";
import { PAYMENT_METHODS, paymentMethodLabel } from "@/server/domain/payment-status";
import { centsToInput, formatIntegerCents, moneyInputToCents } from "@/lib/money";

export interface PaymentInvoiceOption {
  id: string;
  label: string;
  balanceCents: number;
}
const inputClass = "mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";
export function PaymentForm({
  orgSlug, currency, invoices, defaultInvoiceId,
}: {
  orgSlug: string;
  currency: string;
  invoices: PaymentInvoiceOption[];
  defaultInvoiceId?: string;
}) {
  const router = useRouter();
  const [invoiceId, setInvoiceId] = useState(defaultInvoiceId ?? invoices[0]?.id ?? "");
  const [amount, setAmount] = useState(() => {
    const preselected = invoices.find((invoice) => invoice.id === (defaultInvoiceId ?? invoices[0]?.id));
    return preselected ? centsToInput(preselected.balanceCents) : "";
  });
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("CASH");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const amountCents = moneyInputToCents(amount);
  const selected = invoices.find((invoice) => invoice.id === invoiceId);
  const overpayPreview = selected !== undefined && amountCents != null && amountCents > selected.balanceCents;
  async function submit() {
    setPending(true);
    setError(null);
    if (!invoiceId) {
      setError("Select an invoice.");
      setPending(false);
      return;
    }
    if (amountCents == null) {
      setError("Enter the amount as whole dollars or dollars and cents (for example, 1250.00).");
      setPending(false);
      return;
    }
    const result = await recordPayment(paymentRecordSchema.parse({
      invoiceId,
      customerId: null,
      amountCents,
      method,
      notes: notes.trim() ? notes.trim() : null,
    }));
    if (result.ok) {
      router.push(`/${orgSlug}/payments/${result.data.id}`);
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }
  return <div className="space-y-4 rounded-lg border bg-card p-4">
    <div className="grid gap-4 md:grid-cols-2">
      <label>
        <span className={labelClass}>Invoice</span>
        <select value={invoiceId} onChange={(event) => {
          const nextId = event.target.value;
          setInvoiceId(nextId);
          // Default the amount to the newly selected invoice's outstanding balance.
          const next = invoices.find((invoice) => invoice.id === nextId);
          setAmount(next ? centsToInput(next.balanceCents) : amount);
        }} className={inputClass}>
          <option value="">Select an invoice…</option>
          {invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.label}</option>)}
        </select>
        {selected && <span className="mt-1 block text-xs text-muted-foreground">Outstanding balance: {formatIntegerCents(selected.balanceCents, currency)}</span>}
      </label>
      <label>
        <span className={labelClass}>Amount</span>
        <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} />
        {overpayPreview && <span className="mt-1 block text-xs text-destructive">More than the outstanding balance — the server will reject overpayment.</span>}
      </label>
      <label>
        <span className={labelClass}>Method</span>
        <select value={method} onChange={(event) => setMethod(event.target.value as (typeof PAYMENT_METHODS)[number])} className={inputClass}>
          {PAYMENT_METHODS.map((option) => <option key={option} value={option}>{paymentMethodLabel(option)}</option>)}
        </select>
      </label>
      <label>
        <span className={labelClass}>Notes (optional)</span>
        <input value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass} placeholder="Check number, reference…" />
      </label>
    </div>
    <p className="text-sm text-muted-foreground">
      Recording creates a ledger entry and immediately applies it to the invoice: paid and balance are
      recomputed server-side; the payment can later be refunded or voided, which reverses its effect.
    </p>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <Button type="button" onClick={submit} disabled={pending || invoices.length === 0}>{pending ? "Recording…" : "Record payment"}</Button>
  </div>;
}
