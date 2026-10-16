import { logger } from '@/logger/logger.service';
import prisma from '@/prisma/prisma.service';
import { guessCountryCode } from '@/utils/country-name-to-iso';

import { listPayments } from '../settlement/payments';
import {
  formatAddressLines,
  usesBusinessLayout,
  type BusinessLayoutContext,
  type RenderPartyBlock,
} from './render-business-html';

/** The company columns the layout reads — `renderDocumentInstance` selects them with the rest. */
export interface LayoutCompany {
  name: string;
  address?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  email?: string | null;
  dateFormat?: string | null;
}

/**
 * `scheme` -> the label a person reads ("LEGAL_ID" is "EIN" in the United States), from the seeded
 * country-identifier catalog; the scheme itself when the catalog has no row (unseeded database, or a
 * country with no file) — an unlabelled identifier is better than a dropped one.
 */
async function identifierLabels(countryCode: string | null | undefined): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const code = (countryCode ?? '').trim().toUpperCase();
  if (!code) return labels;
  const rows = await prisma.countryIdentifierRequirement.findMany({
    where: { countryCode: code },
    select: { scheme: true, label: true },
  });
  for (const row of rows) labels.set(row.scheme, row.label);
  return labels;
}

function identifiersOf(
  rows: { scheme: string; value: string }[],
  labels: Map<string, string>,
): RenderPartyBlock['identifiers'] {
  return rows
    .filter((row) => row.value)
    .map((row) => ({ label: labels.get(row.scheme) ?? row.scheme, value: row.value }));
}

async function sellerBlock(companyId: string, company: LayoutCompany): Promise<RenderPartyBlock> {
  const countryCode = company.countryCode ?? guessCountryCode(company.country ?? undefined);
  const [identifiers, labels] = await Promise.all([
    prisma.partyIdentifier.findMany({ where: { companyId }, select: { scheme: true, value: true } }),
    identifierLabels(countryCode),
  ]);
  return {
    name: company.name,
    addressLines: formatAddressLines(company),
    identifiers: identifiersOf(identifiers, labels),
    email: company.email,
  };
}

async function buyerBlock(companyId: string, clientId: string): Promise<RenderPartyBlock | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId },
    select: {
      name: true,
      address: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      state: true,
      country: true,
      countryCode: true,
      partyIdentifiers: { select: { scheme: true, value: true } },
      contacts: {
        select: { email: true, isPrimary: true },
        orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
      },
    },
  });
  if (!client?.name) return null;
  const labels = await identifierLabels(client.countryCode ?? guessCountryCode(client.country ?? undefined));
  return {
    name: client.name,
    addressLines: formatAddressLines(client),
    identifiers: identifiersOf(client.partyIdentifiers ?? [], labels),
    email: (client.contacts ?? []).find((contact) => contact.email)?.email ?? null,
  };
}

/** `origin` is a multi-target reference (`{ entity, id }`), `correctsInvoiceId` a single id. */
function referencedIds(data: Record<string, unknown>): { kind: 'origin' | 'corrects'; id: string }[] {
  const found: { kind: 'origin' | 'corrects'; id: string }[] = [];
  const origin = data.origin;
  if (origin && typeof origin === 'object' && typeof (origin as { id?: unknown }).id === 'string') {
    found.push({ kind: 'origin', id: (origin as { id: string }).id });
  } else if (typeof origin === 'string' && origin) {
    found.push({ kind: 'origin', id: origin });
  }
  if (typeof data.correctsInvoiceId === 'string' && data.correctsInvoiceId) {
    found.push({ kind: 'corrects', id: data.correctsInvoiceId });
  }
  return found;
}

/**
 * Everything the invoice/quote/credit-note layout prints that the descriptor loop cannot know (see
 * `RenderDocumentHtmlInput.businessLayout`). Presentation only: a failure to load any of it (a
 * database hiccup, an unseeded catalog) is logged and degrades to the layout's own fallbacks — it
 * must never stop a PDF from being produced, and nothing legally required rides on it (the
 * mentions, QR and payment methods are resolved elsewhere and are not affected).
 */
export async function businessLayoutContextFor(
  companyId: string,
  typeId: string,
  company: LayoutCompany,
  data: Record<string, unknown>,
  documentId: string,
  clientId: string | undefined,
): Promise<BusinessLayoutContext | undefined> {
  if (!usesBusinessLayout(typeId)) return undefined;
  try {
    const [seller, buyer, payments] = await Promise.all([
      sellerBlock(companyId, company),
      clientId ? buyerBlock(companyId, clientId) : Promise.resolve(null),
      typeId === 'invoice' ? listPayments(companyId, documentId) : Promise.resolve([]),
    ]);

    const references: NonNullable<BusinessLayoutContext['references']> = [];
    for (const { kind, id } of referencedIds(data)) {
      const target = await prisma.documentInstance.findFirst({
        where: { id, companyId },
        select: { typeId: true, displayNumber: true },
      });
      if (target?.displayNumber) {
        references.push({ kind, typeId: target.typeId, displayNumber: target.displayNumber });
      }
    }

    return {
      dateFormat: company.dateFormat,
      seller,
      buyer,
      references,
      paidMinor: payments.reduce((sum, payment) => sum + payment.documentAmountMinor, 0),
    };
  } catch (error) {
    logger.warn('Could not load the invoice layout context; printing with the fallbacks', {
      category: 'documents',
      details: { companyId, typeId, message: error instanceof Error ? error.message : String(error) },
    });
    return { dateFormat: company.dateFormat };
  }
}
