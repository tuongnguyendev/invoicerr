import { vi, type Mock } from 'vitest';

import prisma from '@/prisma/prisma.service';

import { businessLayoutContextFor } from './business-layout-context';

vi.mock('@/logger/logger.service', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('@/prisma/prisma.service', () => ({
  __esModule: true,
  default: {
    partyIdentifier: { findMany: vi.fn() },
    countryIdentifierRequirement: { findMany: vi.fn() },
    client: { findFirst: vi.fn() },
    documentInstance: { findFirst: vi.fn() },
    documentPayment: { findMany: vi.fn() },
  },
}));

const company = {
  name: 'TechFaGo LLC',
  address: '1021 E Lincolnway',
  postalCode: '82001',
  city: 'Cheyenne',
  state: 'WY',
  country: 'United States',
  countryCode: 'US',
  email: 'billing@techfago.example',
  dateFormat: 'MM/dd/yyyy',
};

describe('businessLayoutContextFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.partyIdentifier.findMany as Mock).mockResolvedValue([
      { scheme: 'LEGAL_ID', value: '12-3456789' },
    ]);
    (prisma.countryIdentifierRequirement.findMany as Mock).mockResolvedValue([
      { scheme: 'LEGAL_ID', label: 'EIN' },
    ]);
    (prisma.client.findFirst as Mock).mockResolvedValue({
      name: 'PaniTech Academy',
      address: '25 Hang Bac Street',
      city: 'Hanoi',
      country: 'Vietnam',
      partyIdentifiers: [],
      contacts: [{ email: 'accounts@panitech.example', isPrimary: true }],
    });
    (prisma.documentInstance.findFirst as Mock).mockResolvedValue({ typeId: 'quote', displayNumber: 'Q-1' });
    (prisma.documentPayment.findMany as Mock).mockResolvedValue([
      {
        documentId: 'inv-1',
        documentAmountMinor: 1500,
        amountMinor: 1500,
        currency: 'USD',
        paidAt: new Date(),
      },
    ]);
  });

  it('builds the seller (US address, EIN label), the buyer, the origin number and the paid amount', async () => {
    const ctx = await businessLayoutContextFor(
      'co-1',
      'invoice',
      company,
      { origin: { entity: 'quote', id: 'q-1' } },
      'inv-1',
      'client-1',
    );
    expect(ctx?.dateFormat).toBe('MM/dd/yyyy');
    expect(ctx?.seller).toMatchObject({
      name: 'TechFaGo LLC',
      addressLines: ['1021 E Lincolnway', 'Cheyenne, WY 82001, United States'],
      identifiers: [{ label: 'EIN', value: '12-3456789' }],
      email: 'billing@techfago.example',
    });
    expect(ctx?.buyer).toMatchObject({ name: 'PaniTech Academy', email: 'accounts@panitech.example' });
    expect(ctx?.references).toEqual([{ kind: 'origin', typeId: 'quote', displayNumber: 'Q-1' }]);
    expect(ctx?.paidMinor).toBe(1500);
    expect(prisma.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-1', companyId: 'co-1' } }),
    );
  });

  it('skips a referenced document that has no number yet', async () => {
    (prisma.documentInstance.findFirst as Mock).mockResolvedValue({ typeId: 'quote', displayNumber: null });
    const ctx = await businessLayoutContextFor(
      'co-1',
      'invoice',
      company,
      { origin: 'q-1' },
      'inv-1',
      undefined,
    );
    expect(ctx?.references).toEqual([]);
    expect(ctx?.buyer).toBeNull();
  });

  it('is absent for a type that does not use the layout', async () => {
    expect(await businessLayoutContextFor('co-1', 'expense', company, {}, 'x', undefined)).toBeUndefined();
  });

  it('degrades to just the date format when a lookup fails — never blocks the PDF', async () => {
    (prisma.partyIdentifier.findMany as Mock).mockRejectedValue(new Error('db down'));
    const ctx = await businessLayoutContextFor('co-1', 'invoice', company, {}, 'inv-1', 'client-1');
    expect(ctx).toEqual({ dateFormat: 'MM/dd/yyyy' });
  });
});
