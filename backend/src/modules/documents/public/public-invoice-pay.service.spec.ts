import { vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';

import prisma from '@/prisma/prisma.service';

import { PublicInvoicePayService } from './public-invoice-pay.service';

vi.mock('@/prisma/prisma.service', () => ({
  __esModule: true,
  default: {
    company: { findUniqueOrThrow: vi.fn(async () => ({ name: 'Acme SAS', dateFormat: 'MM/dd/yyyy' })) },
    client: { findFirst: vi.fn(async () => ({ name: 'Globex' })) },
  },
}));

const INVOICE = {
  id: 'doc-1',
  status: 'sent',
  displayNumber: 'INV-1',
  data: {
    client: 'client-1',
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    currency: 'EUR',
    notes: 'Thanks!\nNet 15 days.',
    lines: [{ description: 'Consulting', quantity: 2, unitPrice: 50, vatRate: '20' }],
  },
};

const SETTLEMENT = {
  totals: {
    currency: 'EUR',
    lines: [{ netMinor: 10_000 }],
    netMinor: 10_000,
    vatMinor: 2_000,
    grossMinor: 12_000,
  },
  settlement: { paidMinor: 2_000, creditedMinor: 0, outstandingMinor: 10_000 },
};

function build(opts: { resolved?: { typeId: string } | null; available?: boolean } = {}) {
  const resolved =
    opts.resolved === undefined
      ? { companyId: 'company-1', typeId: 'invoice', documentId: 'doc-1' }
      : opts.resolved && { companyId: 'company-1', documentId: 'doc-1', ...opts.resolved };
  const shareLinks = { resolvePublicToken: vi.fn(async () => resolved) };
  const documents = {
    getDocument: vi.fn(async () => INVOICE),
    getSettlement: vi.fn(async () => SETTLEMENT),
  };
  const payments = {
    isOnlinePaymentAvailable: vi.fn(async () => opts.available ?? true),
    createInvoiceCheckoutSession: vi.fn(async () => ({ checkoutUrl: 'https://checkout.stripe.test/s' })),
  };
  const service = new PublicInvoicePayService(shareLinks as never, documents as never, payments as never);
  return { service, shareLinks, documents, payments };
}

describe('PublicInvoicePayService.getSummary', () => {
  it('404s for an unknown/expired/revoked token', async () => {
    const { service } = build({ resolved: null });
    await expect(service.getSummary('nope')).rejects.toThrow(NotFoundException);
  });

  it('404s for a token that opens a non-invoice document', async () => {
    const { service, documents } = build({ resolved: { typeId: 'quote' } });
    await expect(service.getSummary('tok')).rejects.toThrow(NotFoundException);
    expect(documents.getDocument).not.toHaveBeenCalled();
  });

  it('returns lines, totals and the outstanding balance in major units, with no internal ids', async () => {
    const { service } = build();
    const summary = await service.getSummary('tok');

    expect(summary).toMatchObject({
      typeId: 'invoice',
      displayNumber: 'INV-1',
      status: 'sent',
      issueDate: '01/01/2026',
      dueDate: '01/31/2026',
      currency: 'EUR',
      sellerName: 'Acme SAS',
      clientName: 'Globex',
      subtotal: 100,
      tax: 20,
      total: 120,
      paid: 20,
      outstanding: 100,
      canPayOnline: true,
      notes: 'Thanks!\nNet 15 days.',
    });
    expect(summary.lines).toEqual([
      { description: 'Consulting', quantity: 2, unitPrice: 50, lineTotal: 100 },
    ]);
    const serialized = JSON.stringify(summary);
    for (const internal of ['company-1', 'client-1', 'doc-1']) {
      expect(serialized).not.toContain(internal);
    }
    expect(prisma.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-1', companyId: 'company-1' } }),
    );
  });

  it('prints dates only, in the seller format, even when stored as ISO timestamps', async () => {
    const { service, documents } = build();
    documents.getDocument.mockResolvedValue({
      ...INVOICE,
      data: { ...INVOICE.data, issueDate: '2026-10-15T15:12:39.662Z', dueDate: '2026-10-30T00:00:00.000Z' },
    });
    const summary = await service.getSummary('tok');
    expect(summary.issueDate).toBe('10/15/2026');
    expect(summary.dueDate).toBe('10/30/2026');
  });

  it('notes is null when the invoice carries none', async () => {
    const { service, documents } = build();
    documents.getDocument.mockResolvedValue({ ...INVOICE, data: { ...INVOICE.data, notes: '' } });
    expect((await service.getSummary('tok')).notes).toBeNull();
  });

  it('canPayOnline is false when no provider is connected, or nothing is outstanding', async () => {
    const noProvider = build({ available: false });
    expect((await noProvider.service.getSummary('tok')).canPayOnline).toBe(false);

    const settled = build();
    settled.documents.getSettlement.mockResolvedValue({
      ...SETTLEMENT,
      settlement: { paidMinor: 12_000, creditedMinor: 0, outstandingMinor: 0 },
    });
    const view = await settled.service.getSummary('tok');
    expect(view.outstanding).toBe(0);
    expect(view.canPayOnline).toBe(false);
  });

  it('canPayOnline is false for a non-sent invoice', async () => {
    const { service, documents } = build();
    documents.getDocument.mockResolvedValue({ ...INVOICE, status: 'cancelled' });
    expect((await service.getSummary('tok')).canPayOnline).toBe(false);
  });
});

describe('PublicInvoicePayService.createCheckoutSession', () => {
  const originalAppUrl = process.env.APP_URL;
  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

  it('refuses a non-invoice token and never reaches the provider', async () => {
    const { service, payments } = build({ resolved: { typeId: 'quote' } });
    await expect(service.createCheckoutSession('tok')).rejects.toThrow(NotFoundException);
    expect(payments.createInvoiceCheckoutSession).not.toHaveBeenCalled();
  });

  it('404s for an unknown token', async () => {
    const { service } = build({ resolved: null });
    await expect(service.createCheckoutSession('nope')).rejects.toThrow(NotFoundException);
  });

  it('builds success/cancel URLs from APP_URL and the token', async () => {
    process.env.APP_URL = 'https://app.example.com/';
    const { service, payments } = build();

    await expect(service.createCheckoutSession('tok123')).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.test/s',
    });
    expect(payments.createInvoiceCheckoutSession).toHaveBeenCalledWith('company-1', 'doc-1', {
      successUrl: 'https://app.example.com/pay/tok123?payment=success',
      cancelUrl: 'https://app.example.com/pay/tok123?payment=cancelled',
    });
  });
});
