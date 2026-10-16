/**
 * "Email to client" — mails an invoice that is ALREADY numbered to its client, PDF attached, with a
 * link to the customer pay page. The fork sends invoices with the "manual" transport (share link
 * only), where "send" numbers the invoice and emails nobody; this is how the owner then actually
 * delivers it.
 *
 * Modelled on `ShareLinksService`, not on the async "send": "email-client" is declared as an action on
 * the invoice descriptor purely so the country policy and the status lifecycle get an opinion, and is
 * NEVER run through `ActionRegistry`/`runAction`. It deliberately does not touch the invoice (status,
 * number and data are untouched), does not use the transport registry (the company's transport is a
 * fact about "send", not about this) and does not use the queue: the user is looking at a dialog and
 * wants to know NOW whether the mail went, so a mailer failure is returned as an error to the caller
 * instead of ending in `send_failed`. It records nothing in payments.
 *
 * Gates, in `ShareLinksService.create`'s order: type/action known (404) -> country policy (403) ->
 * document exists for this company (404) -> status (409) -> recipient (400).
 */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { logger } from '@/logger/logger.service';
import { isValidEmailAddress } from '@/mail/is-valid-email';
import { MailService } from '@/mail/mail.service';
import { ClientsService } from '@/modules/clients/clients.service';
import { SigningCertificatesService } from '@/modules/company/signing-certificates/signing-certificates.service';

import { DocumentInstanceResult } from '../actions/action-registry';
import { EMAIL_CLIENT_ACTION_ID } from '../actions/email-template';
import { sendDocumentInstanceEmail } from '../actions/send-document-email';
import { evaluateCountryPolicy } from '../country-policy/country-policy';
import { DocumentTypeRegistry } from '../descriptors/type-registry';
import { isActionAvailable } from '../descriptors/types';
import { DocumentsService } from '../documents.service';
import { EntityReferenceRegistry } from '../references/reference-registry';
import { ShareLinksService } from '../share-links/share-links.service';
import { DOCUMENT_TYPE_REGISTRY, ENTITY_REFERENCE_REGISTRY } from '../tokens';

export interface EmailClientResult {
  /** Human-facing outcome, e.g. "Invoice sent to a@b.com." */
  message: string;
  recipient: string;
  /** The pay link that was put in the email (its token is only ever shown in the mail itself). */
  shareLinkId: string;
}

/** The frontend origin the pay page lives on — the same `APP_URL` the signature-request and portal
 *  emails build their links from. */
function appBaseUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

@Injectable()
export class EmailClientService {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly shareLinksService: ShareLinksService,
    private readonly clientsService: ClientsService,
    private readonly mailService: MailService,
    @Inject(DOCUMENT_TYPE_REGISTRY) private readonly typeRegistry: DocumentTypeRegistry,
    @Inject(ENTITY_REFERENCE_REGISTRY) private readonly referenceRegistry: EntityReferenceRegistry,
    private readonly signingCertificates: SigningCertificatesService,
  ) {}

  /**
   * `override` (the body's optional recipient) wins over the client's primary contact; it is trimmed
   * and validated, never trusted. Without an override the primary contact's email is used
   * (`ClientsService.getClientById` derives it through `findPrimaryContact`).
   */
  private async resolveRecipient(
    companyId: string,
    data: unknown,
    override: string | undefined,
  ): Promise<string> {
    if (override !== undefined && override !== null) {
      const candidate = String(override).trim();
      if (candidate !== '') {
        if (!isValidEmailAddress(candidate)) {
          throw new BadRequestException(`"${candidate}" is not a valid email address.`);
        }
        return candidate;
      }
    }
    const record = (data ?? {}) as Record<string, unknown>;
    const clientId = typeof record.client === 'string' ? record.client : undefined;
    const client = clientId ? await this.clientsService.getClientById(companyId, clientId) : null;
    const email = client?.contactEmail?.trim();
    if (!email) {
      throw new BadRequestException(
        "This client has no contact email on file. Add one to the client's primary contact, or type the " +
          'recipient address yourself.',
      );
    }
    return email;
  }

  async send(
    companyId: string,
    typeId: string,
    documentId: string,
    overrideRecipient?: string,
  ): Promise<EmailClientResult> {
    const descriptor = this.documentsService.getType(typeId); // 404s for an unknown typeId.
    const action = descriptor.actions.find((candidate) => candidate.id === EMAIL_CLIENT_ACTION_ID);
    if (!action) {
      throw new NotFoundException(`Document type "${typeId}" has no action "${EMAIL_CLIENT_ACTION_ID}".`);
    }

    const policyDecision = await evaluateCountryPolicy(companyId, typeId, EMAIL_CLIENT_ACTION_ID);
    if (!policyDecision.allowed) {
      throw new ForbiddenException(policyDecision.reason);
    }

    const instance = await this.documentsService.getDocument(companyId, typeId, documentId);

    if (!isActionAvailable(action, instance.status)) {
      throw new ConflictException(
        `Cannot email a document with status "${instance.status}" — only an invoice that has been ` +
          'numbered and sent can be emailed to the client.',
      );
    }
    if (
      policyDecision.restrictedToStatuses &&
      !policyDecision.restrictedToStatuses.includes(instance.status)
    ) {
      throw new ConflictException(
        `Action "${EMAIL_CLIENT_ACTION_ID}" of document type "${typeId}" is restricted by this company's ` +
          `country policy to status(es) ${policyDecision.restrictedToStatuses.join(', ')}, not "${instance.status}".`,
      );
    }

    // Recipient BEFORE the link: a 400 must not leave a freshly minted public link behind.
    const recipient = await this.resolveRecipient(companyId, instance.data, overrideRecipient);

    // A fresh link per send (30 days, revocable from the share-link list): the raw token only exists
    // at creation, so an earlier link can never be re-used here.
    const link = await this.shareLinksService.create(companyId, typeId, documentId);
    const payUrl = `${appBaseUrl()}${link.path}`;

    try {
      const result = await sendDocumentInstanceEmail(
        {
          mailService: this.mailService,
          typeRegistry: this.typeRegistry,
          referenceRegistry: this.referenceRegistry,
          signingCertificates: this.signingCertificates,
        },
        {
          companyId,
          typeId,
          document: instance as unknown as DocumentInstanceResult,
          recipient,
          label: descriptor.label,
          payUrl,
        },
      );
      logger.info('Document emailed to client', {
        category: 'documents',
        details: { companyId, typeId, documentId, shareLinkId: link.id },
      });
      return { message: result.message, recipient, shareLinkId: link.id };
    } catch (error) {
      logger.error('Emailing a document to its client failed', {
        category: 'documents',
        details: {
          companyId,
          typeId,
          documentId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      // A named refusal (e.g. "no mail server configured") is already a clear HTTP error.
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(
        `The email could not be sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
