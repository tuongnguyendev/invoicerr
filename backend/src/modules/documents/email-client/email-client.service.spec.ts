import { vi, type Mock } from 'vitest';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import * as sendDocumentEmail from '../actions/send-document-email';
import * as countryPolicy from '../country-policy/country-policy';
import { buildExpenseDescriptor } from '../descriptors/expense.descriptor';
import { buildInvoiceDescriptor } from '../descriptors/invoice.descriptor';
import { DocumentsController } from '../documents.controller';
import { EmailClientService } from './email-client.service';

vi.mock('../actions/send-document-email');
vi.mock('../country-policy/country-policy');

/**
 * `EmailClientService` with its collaborators faked at their boundary (documents, share links,
 * clients, the shared "compose + attach + send" core). What is proven here is the orchestration: the
 * gates, the recipient resolution, that a fresh pay link is minted and handed to the template as an
 * absolute `payUrl`, and that nothing about the invoice is ever written. The template interpolation
 * and the attachment themselves are covered against the real core in `send-document-email.spec.ts`.
 */
function build(
  overrides: { status?: string; contactEmail?: string | null; data?: Record<string, unknown> } = {},
) {
  const invoice = buildInvoiceDescriptor();
  const expense = buildExpenseDescriptor();
  const instance = {
    id: 'inv-1',
    typeId: 'invoice',
    status: overrides.status ?? 'sent',
    data: overrides.data ?? { client: 'client-1' },
    displayNumber: 'INV-0001',
  };
  const documentsService = {
    getType: vi.fn((typeId: string) => {
      if (typeId === 'invoice') return invoice;
      if (typeId === 'expense') return expense;
      throw new NotFoundException(`unknown type ${typeId}`);
    }),
    getDocument: vi.fn().mockResolvedValue(instance),
    // Anything that would write is a failing call: the action must be read-only on the invoice.
    runAction: vi.fn(),
  };
  const shareLinksService = {
    create: vi.fn().mockResolvedValue({ id: 'link-1', token: 'tok', path: '/pay/tok', pdfPath: '/x' }),
  };
  const clientsService = {
    getClientById: vi.fn().mockResolvedValue({
      id: 'client-1',
      contactEmail: overrides.contactEmail === undefined ? 'billing@client.test' : overrides.contactEmail,
    }),
  };
  const service = new EmailClientService(
    documentsService as never,
    shareLinksService as never,
    clientsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, documentsService, shareLinksService, clientsService, instance };
}

beforeEach(() => {
  process.env.APP_URL = 'https://app.test/';
  (countryPolicy.evaluateCountryPolicy as Mock).mockResolvedValue({ allowed: true });
  (sendDocumentEmail.sendDocumentInstanceEmail as Mock).mockResolvedValue({
    message: 'Invoice sent to x.',
    artifacts: [],
  });
});
afterEach(() => vi.resetAllMocks());

describe('EmailClientService.send', () => {
  it("emails the client's primary contact with an absolute pay link and never writes the invoice", async () => {
    const { service, shareLinksService, documentsService, instance } = build();

    const result = await service.send('company-1', 'invoice', 'inv-1');

    expect(result).toEqual({
      message: 'Invoice sent to x.',
      recipient: 'billing@client.test',
      shareLinkId: 'link-1',
    });
    expect(shareLinksService.create).toHaveBeenCalledWith('company-1', 'invoice', 'inv-1');
    const [, input] = (sendDocumentEmail.sendDocumentInstanceEmail as Mock).mock.calls[0];
    expect(input).toMatchObject({
      companyId: 'company-1',
      typeId: 'invoice',
      recipient: 'billing@client.test',
      label: 'Invoice',
      payUrl: 'https://app.test/pay/tok',
    });
    // The document handed to the mailer is the stored one, in its current status: not re-saved, not
    // transitioned, no action run.
    expect(input.document).toBe(instance);
    expect(input.document.status).toBe('sent');
    expect(documentsService.runAction).not.toHaveBeenCalled();
  });

  it('also works from send_failed', async () => {
    const { service } = build({ status: 'send_failed' });
    await expect(service.send('company-1', 'invoice', 'inv-1')).resolves.toMatchObject({
      recipient: 'billing@client.test',
    });
  });

  it('uses a valid override recipient (trimmed) instead of the client contact', async () => {
    const { service, clientsService } = build();
    const result = await service.send('company-1', 'invoice', 'inv-1', '  other@client.test ');
    expect(result.recipient).toBe('other@client.test');
    expect(clientsService.getClientById).not.toHaveBeenCalled();
  });

  it('rejects an invalid override with 400 and mints no link', async () => {
    const { service, shareLinksService } = build();
    await expect(service.send('company-1', 'invoice', 'inv-1', 'not-an-email')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(shareLinksService.create).not.toHaveBeenCalled();
  });

  it('answers 400 with a clear message when the client has no email and no override was given', async () => {
    const { service, shareLinksService } = build({ contactEmail: null });
    await expect(service.send('company-1', 'invoice', 'inv-1')).rejects.toThrow(/no contact email/);
    expect(shareLinksService.create).not.toHaveBeenCalled();
    expect(sendDocumentEmail.sendDocumentInstanceEmail).not.toHaveBeenCalled();
  });

  it('a blank override falls back to the client contact', async () => {
    const { service } = build();
    expect((await service.send('company-1', 'invoice', 'inv-1', '   ')).recipient).toBe(
      'billing@client.test',
    );
  });

  it.each([
    'draft',
    'validated',
    'sending',
    'cancelled',
  ])('is refused with 409 for a %s invoice', async (status) => {
    const { service } = build({ status });
    await expect(service.send('company-1', 'invoice', 'inv-1')).rejects.toBeInstanceOf(ConflictException);
    expect(sendDocumentEmail.sendDocumentInstanceEmail).not.toHaveBeenCalled();
  });

  it('is refused with 403 when the country policy forbids it', async () => {
    (countryPolicy.evaluateCountryPolicy as Mock).mockResolvedValue({ allowed: false, reason: 'nope' });
    const { service } = build();
    await expect(service.send('company-1', 'invoice', 'inv-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(countryPolicy.evaluateCountryPolicy).toHaveBeenCalledWith('company-1', 'invoice', 'email-client');
  });

  it('is refused with 409 when the country policy narrows the statuses further', async () => {
    (countryPolicy.evaluateCountryPolicy as Mock).mockResolvedValue({
      allowed: true,
      restrictedToStatuses: ['draft'],
    });
    const { service } = build();
    await expect(service.send('company-1', 'invoice', 'inv-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s for a type that does not declare the action', async () => {
    const { service } = build();
    await expect(service.send('company-1', 'expense', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('surfaces a mailer failure as a clear 502, not a silent success', async () => {
    (sendDocumentEmail.sendDocumentInstanceEmail as Mock).mockRejectedValue(new Error('SES said no'));
    const { service } = build();
    const failure = service.send('company-1', 'invoice', 'inv-1');
    await expect(failure).rejects.toBeInstanceOf(BadGatewayException);
    await expect(failure).rejects.toThrow(/SES said no/);
  });
});

describe('DocumentsController.emailClient', () => {
  it('delegates to the service with the body recipient, if any', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const controller = new DocumentsController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { send } as never,
    );
    await controller.emailClient('company-1', 'inv-1', 'invoice', { recipient: 'a@b.test' });
    expect(send).toHaveBeenCalledWith('company-1', 'invoice', 'inv-1', 'a@b.test');
    await controller.emailClient('company-1', 'inv-1', 'invoice', undefined);
    expect(send).toHaveBeenLastCalledWith('company-1', 'invoice', 'inv-1', undefined);
  });
});
