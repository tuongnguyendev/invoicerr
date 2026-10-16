import { useApiMutation, useApiQuery } from "@/hooks/use-api-query"

/**
 * The customer pay page's two PUBLIC endpoints (`backend/.../public/public-documents.controller.ts`):
 * the share-link token in the URL is the only credential. Like `use-public-signature.ts`, these ride
 * on the ordinary `useApi*` hooks — the backend's `@Public()` is what makes "no session" work, and a
 * 404 (bad/expired/revoked token) never triggers the sign-in redirect, which is 401-only.
 */

export interface PublicInvoiceLine {
  description: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

/** Mirrors the backend's `PublicInvoiceSummary`. Amounts are MAJOR units (already divided by the
 *  currency's decimals server-side), so the page only formats them. */
export interface PublicInvoiceSummary {
  typeId: string
  displayNumber: string | null
  status: string
  issueDate: string | null
  dueDate: string | null
  currency: string
  sellerName: string
  clientName: string | null
  lines: PublicInvoiceLine[]
  subtotal: number
  tax: number
  total: number
  paid: number
  credited: number
  outstanding: number
  canPayOnline: boolean
}

export const publicInvoiceKey = (token: string) => ["public-invoice", token]

export function usePublicInvoice(token: string) {
  return useApiQuery<PublicInvoiceSummary>(
    publicInvoiceKey(token),
    `/api/public/documents/${encodeURIComponent(token)}`,
    { retry: false, enabled: !!token },
  )
}

export function useCreatePublicInvoiceCheckout(token: string) {
  return useApiMutation<void, { checkoutUrl: string }>(
    "POST",
    `/api/public/documents/${encodeURIComponent(token)}/checkout-session`,
  )
}
