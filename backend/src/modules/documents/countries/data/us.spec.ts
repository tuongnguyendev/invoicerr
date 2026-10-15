/**
 * Content spec for the United States country file, restored after the 5-country prune (commit
 * b68685e5). Reads `countries/data/us.json` through the same composed catalog every consumer uses,
 * and proves the two things a US seller needs: invoices and quotes are declared and sendable, and the
 * cross-border tax engine resolves a treatment (rather than hard-blocking) from a US seller.
 */
import { resolveInvoiceCrossBorderTax } from '../../tax/resolve-invoice-tax';
import { ALL_COMPOSED_COUNTRIES } from '../compose';

function us() {
  const view = ALL_COMPOSED_COUNTRIES.find((c) => c.countryCode === 'US');
  if (!view) throw new Error('No US composed country view');
  return view;
}

const lines = () => [
  { description: 'Consulting', quantity: 1, unitPrice: 1000, vatRate: '0', supplyType: 'SERVICES' },
];

describe('US — countries/data/us.json', () => {
  it('declares invoice and quote, and allows invoice.send and quote.send', () => {
    const policy = us().policy!;
    expect(policy.documentTypes).toEqual(expect.arrayContaining(['invoice', 'quote']));
    for (const typeId of ['invoice', 'quote']) {
      const rule = policy.rules.find((r) => r.typeId === typeId && r.actionId === 'send');
      expect(rule?.allowed).toBe(true);
    }
  });

  it('declares a SALES_TAX tax system with unverified provenance', () => {
    const tax = us().taxSystem!;
    expect(tax.kind).toBe('SALES_TAX');
    expect(tax.provenance.kind).toBe('unverified');
  });

  it('keeps the EIN identifier optional', () => {
    const scheme = us().identifiers!.schemes.find((s) => s.label === 'EIN');
    expect(scheme?.required).toBe(false);
  });

  it('WY seller to a buyer in another US state: domestic, resolves without a block', () => {
    const data = { client: 'c', currency: 'USD', lines: lines() };
    const result = resolveInvoiceCrossBorderTax({
      seller: { countryCode: 'US' },
      buyer: { countryCode: 'US' },
      data,
    });
    expect(result.crossBorder).toBe(false);
  });

  it('WY seller to a French buyer: cross-border, resolves a treatment without a block', () => {
    const data = { client: 'c', currency: 'USD', lines: lines() };
    const result = resolveInvoiceCrossBorderTax({
      seller: { countryCode: 'US' },
      buyer: { countryCode: 'FR' },
      data,
    });
    expect(result.crossBorder).toBe(true);
    const line = (result.data.lines as Record<string, unknown>[])[0];
    expect(line.__crossBorderCategory).toBeDefined();
  });
});
