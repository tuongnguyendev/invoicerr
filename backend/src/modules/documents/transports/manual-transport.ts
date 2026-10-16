import { DocumentTransport, DocumentTransportResult } from './transport-registry';

/**
 * The id a company with NO `invoiceTransportId` resolves to (`actions/invoice-actions.ts`,
 * `resolveInvoiceTransport`). Upstream deliberately had "no default channel": an unconfigured company
 * was blocked, so the product never guessed how an invoice should leave. This fork chooses
 * share-link-first instead: the owner sends the invoice himself (chat, his own mail client...) with
 * the public pay link, so "nothing configured" means "I deliver it myself", not "refuse to send".
 * A country channel MANDATE still wins over this default (the mandate check runs before it), so a
 * mandated country is never silently downgraded to a hand-delivered invoice.
 */
export const DEFAULT_INVOICE_TRANSPORT_ID = 'manual';

/**
 * The built-in "manual" transport — "Share link only". It performs NO outbound I/O: the user hands
 * the invoice to the client by his own means (the staff UI offers the `/pay/<token>` share link right
 * after the send). Succeeding immediately is what lets the invoice run through the ordinary send
 * pipeline (numbering, `sending`, then `sent` in `async-send.ts`) exactly like a delivered email,
 * with no lifecycle special case.
 *
 * No `reference`/`providerId`: there is no platform-side conformity concept, so no poller ever picks
 * it up and nothing waits on a receipt. No `artifacts`: nothing was delivered, so nothing is archived
 * by the send (the same "absent means nothing conservable" contract `DocumentTransportResult` holds).
 * `deliversCreditNotes` is true: a credit note has no recipient to resolve here, so the channel can
 * carry one as trivially as it carries an invoice.
 */
export function buildManualTransport(): DocumentTransport {
  return {
    deliversCreditNotes: true,
    async send(ctx): Promise<DocumentTransportResult> {
      return {
        message: `${ctx.label} marked as sent. Share its link with your client — nothing was emailed.`,
      };
    },
  };
}
