/**
 * The id of the backend's built-in "share link only" transport
 * (`backend/src/modules/documents/transports/manual-transport.ts`). A company with NO configured
 * invoice transport resolves to it on the backend (`resolveInvoiceTransport`), so "not configured"
 * and "manual" are the same thing here too.
 */
export const MANUAL_TRANSPORT_ID = "manual"

/**
 * Whether a successful action should immediately offer the customer pay link: the invoice's "send"
 * through the manual transport. Nothing was delivered by the product in that case — the owner hands
 * the invoice over himself — so the link is the very next thing he needs. `company` undefined (still
 * loading) answers false: guessing the default before the real choice is known would pop the dialog
 * for a company that emails its invoices.
 */
export function shouldOfferShareLinkAfter(
  typeId: string,
  actionId: string,
  company: { invoiceTransportId?: string | null } | undefined,
): boolean {
  if (typeId !== "invoice" || actionId !== "send" || !company) return false
  return (company.invoiceTransportId || MANUAL_TRANSPORT_ID) === MANUAL_TRANSPORT_ID
}

/** The settings select's options with the manual (default, recommended) channel first, the rest in
 *  the order the backend listed them. */
export function orderTransportsManualFirst<T extends { id: string }>(transports: T[]): T[] {
  return [
    ...transports.filter((transport) => transport.id === MANUAL_TRANSPORT_ID),
    ...transports.filter((transport) => transport.id !== MANUAL_TRANSPORT_ID),
  ]
}
