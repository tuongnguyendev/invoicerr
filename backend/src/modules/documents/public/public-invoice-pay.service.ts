import { Injectable, NotFoundException } from '@nestjs/common';

import prisma from '@/prisma/prisma.service';
import { fromMinor } from '@/utils/financial';

import { DocumentsService } from '../documents.service';
import { InvoiceCheckoutSessionResult, PaymentSessionsService } from '../payments/payment-sessions.service';
import { ResolvedShareLink, ShareLinksService } from '../share-links/share-links.service';

export interface PublicInvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Net of the line's own discount, before VAT — the figure `computeDocumentTotals` sums. */
  lineTotal: number;
}

/**
 * What the public pay page (`/pay/:token`) renders. Everything here is already printed on the invoice
 * PDF the same token serves (parties' display names, lines, totals); the internal ids (company, client,
 * document) are deliberately absent, and amounts are MAJOR units (`fromMinor`) so the page never needs
 * to know a currency's decimals.
 */
export interface PublicInvoiceSummary {
  typeId: string;
  displayNumber: string | null;
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  sellerName: string;
  clientName: string | null;
  lines: PublicInvoiceLine[];
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  credited: number;
  outstanding: number;
  /** A hint for drawing the "Pay" button only — the checkout POST re-checks everything. */
  canPayOnline: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The customer-facing half of "send one link, get paid": a share-link token (the same bearer token
 * `GET /public/documents/:token/pdf` honours) now also opens a read-only invoice summary and starts a
 * Stripe (or whichever provider the company connected) Checkout. Like `PortalService`, this class only
 * decides "does this token's holder get to ask about THIS document" — status, balance and provider
 * connectivity are `PaymentSessionsService`'s to enforce.
 *
 * Only invoices are payable: any other type's token resolves (it is a valid PDF link) but answers the
 * same 404 as an unknown token, so this page never confirms what kind of document a token opens.
 */
@Injectable()
export class PublicInvoicePayService {
  constructor(
    private readonly shareLinksService: ShareLinksService,
    private readonly documentsService: DocumentsService,
    private readonly paymentSessions: PaymentSessionsService,
  ) {}

  /** The one 404 for unknown / expired / revoked tokens AND for a non-invoice document. */
  private async resolveInvoiceToken(token: string): Promise<ResolvedShareLink> {
    const resolved = await this.shareLinksService.resolvePublicToken(token);
    if (resolved?.typeId !== 'invoice') {
      throw new NotFoundException('Link not found or expired.');
    }
    return resolved;
  }

  async getSummary(token: string): Promise<PublicInvoiceSummary> {
    const { companyId, documentId } = await this.resolveInvoiceToken(token);

    const document = await this.documentsService.getDocument(companyId, 'invoice', documentId);
    const { totals, settlement } = await this.documentsService.getSettlement(
      companyId,
      'invoice',
      documentId,
    );
    const data = (document.data ?? {}) as Record<string, unknown>;
    const currency = totals.currency ?? asString(data.currency) ?? '';
    const money = (minor: number) => fromMinor(minor, currency || 'EUR');

    const clientId = asString(data.client);
    const [company, client] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
      clientId
        ? prisma.client.findFirst({ where: { id: clientId, companyId }, select: { name: true } })
        : Promise.resolve(null),
    ]);

    const rows = Array.isArray(data.lines) ? (data.lines as Record<string, unknown>[]) : [];
    const lines: PublicInvoiceLine[] = rows.map((row, index) => ({
      description: asString(row.description) ?? '',
      quantity: typeof row.quantity === 'number' ? row.quantity : 1,
      unitPrice: typeof row.unitPrice === 'number' ? row.unitPrice : 0,
      lineTotal: money(totals.lines[index]?.netMinor ?? 0),
    }));

    const canPayOnline =
      document.status === 'sent' &&
      settlement.outstandingMinor > 0 &&
      (await this.paymentSessions.isOnlinePaymentAvailable(companyId, clientId ?? undefined));

    return {
      typeId: 'invoice',
      displayNumber: document.displayNumber ?? null,
      status: document.status,
      issueDate: asString(data.issueDate),
      dueDate: asString(data.dueDate),
      currency,
      sellerName: company.name,
      clientName: client?.name ?? null,
      lines,
      subtotal: money(totals.netMinor),
      tax: money(totals.vatMinor),
      total: money(totals.grossMinor),
      paid: money(settlement.paidMinor),
      credited: money(settlement.creditedMinor),
      outstanding: money(settlement.outstandingMinor),
      canPayOnline,
    };
  }

  /**
   * Opens (or reuses) a checkout for the token's invoice. The return URLs point back at the pay page
   * and DO carry the share token: it is a bearer for one invoice's PDF and pay page only (never a
   * session or portal credential), and the page is useless without it. The `?payment=` flag is never a
   * payment signal — only the verified webhook moves the balance; it just picks which banner shows.
   */
  async createCheckoutSession(token: string): Promise<InvoiceCheckoutSessionResult> {
    const { companyId, documentId } = await this.resolveInvoiceToken(token);
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    return this.paymentSessions.createInvoiceCheckoutSession(companyId, documentId, {
      successUrl: `${appUrl}/pay/${token}?payment=success`,
      cancelUrl: `${appUrl}/pay/${token}?payment=cancelled`,
    });
  }
}
