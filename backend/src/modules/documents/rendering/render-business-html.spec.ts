import { buildCreditNoteDescriptor } from '../descriptors/credit-note.descriptor';
import { buildInvoiceDescriptor } from '../descriptors/invoice.descriptor';
import { buildQuoteDescriptor } from '../descriptors/quote.descriptor';
import { computeDocumentTotals } from '../totals/compute-totals';
import { formatAddressLines, formatLayoutDate, usesBusinessLayout } from './render-business-html';
import { renderDocumentHtml, RenderDocumentHtmlInput } from './render-html';

/**
 * The dedicated invoice / quote / credit-note layout. The generic renderer's own behaviour (every
 * other type) stays pinned by `render-html.spec.ts`, whose snapshot did not change.
 */

const NOTES = 'Thank you for your business.\nPlease pay within 15 days.\n<b>not markup</b>';

const usLines = [
  { description: 'Website audit', quantity: 1, unitPrice: 50, vatRate: '0' },
  { description: 'Hosting setup', quantity: 1, unitPrice: 40, vatRate: '0' },
  { description: 'Training session', quantity: 2, unitPrice: 20, vatRate: '0' },
  { description: 'Support hours', quantity: 2, unitPrice: 10, vatRate: '0' },
  { description: 'Domain registration', quantity: 1, unitPrice: 40, vatRate: '0' },
  { description: 'Goodwill gesture', quantity: 1, unitPrice: 0, vatRate: '0' },
];

function usInvoiceInput(overrides: Partial<RenderDocumentHtmlInput> = {}): RenderDocumentHtmlInput {
  const descriptor = buildInvoiceDescriptor();
  const data = {
    client: 'client-1',
    origin: { entity: 'quote', id: 'quote-1' },
    issueDate: '2026-10-15T15:12:39.662Z',
    dueDate: '2026-10-30T00:00:00.000Z',
    currency: 'USD',
    notes: NOTES,
    lines: usLines,
  };
  return {
    descriptor,
    instance: {
      id: 'inv-1',
      status: 'sent',
      data,
      createdAt: new Date('2026-10-15T15:12:39.662Z'),
      displayNumber: 'INV-2026-0007',
    },
    company: { name: 'TechFaGo LLC' },
    referenceLabels: { client: 'PaniTech Academy', origin: 'PaniTech Academy — 2026-10-01' },
    totals: computeDocumentTotals(descriptor, data),
    paymentMethods: [{ label: 'Stripe', lines: ['Pay by card'], link: 'https://pay.example/inv-1' }],
    businessLayout: {
      dateFormat: 'MM/dd/yyyy',
      seller: {
        name: 'TechFaGo LLC',
        addressLines: ['1021 E Lincolnway', 'Cheyenne, WY 82001, United States'],
        identifiers: [{ label: 'EIN', value: '12-3456789' }],
        email: 'billing@techfago.example',
      },
      buyer: {
        name: 'PaniTech Academy',
        addressLines: ['12 Academy Road', 'Hanoi, Vietnam'],
        identifiers: [],
        email: 'accounts@panitech.example',
      },
      references: [{ kind: 'origin', typeId: 'quote', displayNumber: 'Q-2026-0001' }],
    },
    ...overrides,
  };
}

describe('usesBusinessLayout', () => {
  it('covers exactly invoice, quote and credit note', () => {
    expect(['invoice', 'quote', 'credit-note'].every(usesBusinessLayout)).toBe(true);
    expect(usesBusinessLayout('expense')).toBe(false);
    expect(usesBusinessLayout('purchase-order')).toBe(false);
  });
});

describe('invoice layout (US sample)', () => {
  const html = renderDocumentHtml(usInvoiceInput());

  it('never prints an ISO timestamp or a time component; dates use the company format', () => {
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(html).not.toContain('15:12');
    expect(html).toContain('10/15/2026');
    expect(html).toContain('10/30/2026');
  });

  it('prints no empty "Corrects invoice" card, no Currency card, no Origin document card', () => {
    expect(html).not.toContain('Corrects invoice');
    expect(html).not.toContain('field-row');
    expect(html).not.toContain('Origin document');
    expect(html).not.toContain('Currency');
  });

  it('shows the origin by NUMBER, not by the picker label', () => {
    expect(html).toContain('Ref: Quote Q-2026-0001');
    expect(html).not.toContain('PaniTech Academy — 2026-10-01');
  });

  it('hides the all-zero VAT column, the empty Unit and Discount columns, and any VAT row', () => {
    expect(html).not.toContain('>VAT<');
    expect(html).not.toContain('>Unit<');
    expect(html).not.toContain('>Discount<');
    expect(html).not.toContain('VAT 0');
    expect(html).not.toContain('Subtotal');
  });

  it('prints the six lines, the right-aligned amounts and a single Total of 190.00 USD', () => {
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(6);
    expect(html).toContain('<th class="num">Amount (USD)</th>');
    expect(html).toContain('190.00 USD');
    expect(html).toContain('<span>Total</span>');
  });

  it('prints both parties (seller block with identifier, bill-to with address)', () => {
    expect(html).toContain('TechFaGo LLC');
    expect(html).toContain('1021 E Lincolnway');
    expect(html).toContain('EIN: 12-3456789');
    expect(html).toContain('Bill to');
    expect(html).toContain('PaniTech Academy');
    expect(html).toContain('12 Academy Road');
    expect(html).toContain('accounts@panitech.example');
  });

  it('prints the notes with their line breaks preserved, in a normal font, escaped', () => {
    expect(html).toContain('class="notes-body"');
    expect(html).toContain('Thank you for your business.\nPlease pay within 15 days.');
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).not.toContain('<pre');
  });

  it('keeps the payment methods section', () => {
    expect(html).toContain('Payment methods');
    expect(html).toContain('Stripe');
    expect(html).toContain('https://pay.example/inv-1');
  });

  it('is a compact single-flow page: title, number, status', () => {
    expect(html).toContain('>Invoice<');
    expect(html).toContain('INV-2026-0007');
    expect(html).toContain('<span class="k">Status</span> sent');
  });

  it('matches the pinned layout (a deliberate diff only)', () => {
    expect(html).toMatchSnapshot();
  });
});

describe('invoice layout — conditional columns and totals', () => {
  function withLines(lines: Record<string, unknown>[], extra: Partial<RenderDocumentHtmlInput> = {}) {
    const descriptor = buildInvoiceDescriptor();
    const data = { client: 'c', issueDate: '2026-10-15', dueDate: '2026-10-30', currency: 'EUR', lines };
    return renderDocumentHtml({
      descriptor,
      instance: { id: 'i', status: 'draft', data, createdAt: new Date('2026-10-15') },
      company: { name: 'Acme' },
      referenceLabels: { client: 'Client' },
      totals: computeDocumentTotals(descriptor, data),
      ...extra,
    });
  }

  it('shows the VAT column and Subtotal/VAT rows once a line has a non-zero rate', () => {
    const html = withLines([{ description: 'Work', quantity: 1, unitPrice: 100, vatRate: '20' }]);
    expect(html).toContain('>VAT<');
    expect(html).toContain('20%');
    expect(html).toContain('Subtotal');
    expect(html).toContain('VAT 20% on 100.00 EUR');
    expect(html).toContain('120.00 EUR');
  });

  it('shows the Unit and Discount columns only when some line uses them', () => {
    const html = withLines([
      { description: 'Work', quantity: 2, unit: 'HUR', unitPrice: 100, vatRate: '0', discountPercent: 10 },
    ]);
    expect(html).toContain('>Unit<');
    expect(html).toContain('>Discount<');
    expect(html).toContain('10%');
    expect(html).toContain('180.00');
  });

  it('prints Paid and Amount due only when payments exist', () => {
    const lines = [{ description: 'Work', quantity: 1, unitPrice: 100, vatRate: '0' }];
    expect(withLines(lines)).not.toContain('Amount due');
    const paid = withLines(lines, { businessLayout: { paidMinor: 4000 } });
    expect(paid).toContain('Paid');
    expect(paid).toContain('-40.00 EUR');
    expect(paid).toContain('Amount due');
    expect(paid).toContain('60.00 EUR');
  });

  it('prints a client reference / PO number only when present', () => {
    const descriptor = buildInvoiceDescriptor();
    const data = {
      client: 'c',
      issueDate: '2026-10-15',
      currency: 'EUR',
      clientReference: 'PO-77',
      lines: [],
    };
    const html = renderDocumentHtml({
      descriptor,
      instance: { id: 'i', status: 'draft', data, createdAt: new Date('2026-10-15') },
      company: { name: 'Acme' },
      referenceLabels: {},
    });
    expect(html).toContain('Your reference: PO-77');
    expect(html).not.toContain('Due date');
  });

  it('escapes every data value (client, seller, line description, reference)', () => {
    const html = withLines(
      [{ description: '<img src=x onerror=alert(1)>', quantity: 1, unitPrice: 1, vatRate: '0' }],
      {
        company: { name: '<script>seller</script>' },
        referenceLabels: { client: '<script>buyer</script>' },
      },
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;buyer&lt;/script&gt;');
  });
});

describe('invoice layout — legally required content survives (France)', () => {
  it('still emits the legal mentions, the national-currency VAT rows, the ATCUD and the status line', () => {
    const descriptor = buildInvoiceDescriptor();
    const data = {
      client: 'c',
      issueDate: '2026-06-30',
      dueDate: '2026-07-30',
      currency: 'USD',
      lines: [{ description: 'Conseil', quantity: 1, unitPrice: 100, vatRate: '20' }],
    };
    const html = renderDocumentHtml({
      descriptor,
      instance: {
        id: 'i',
        status: 'sent',
        data,
        createdAt: new Date('2026-06-30'),
        displayNumber: 'F-2026-001',
        atcud: 'ABCD1234-1',
      },
      company: {
        name: 'Société Exemple',
        address: '1 rue de Paris',
        postalCode: '75001',
        city: 'Paris',
        country: 'France',
      },
      referenceLabels: { client: 'Client' },
      language: 'fr',
      totals: computeDocumentTotals(descriptor, data),
      legalMentions: [
        { text: 'Indemnité forfaitaire pour frais de recouvrement : 40 €', legalRef: 'PMT' },
        { text: 'TVA non applicable, art. 293 B du CGI', legalRef: 'FR_293B' },
      ],
      vatNationalCurrency: {
        currency: 'EUR',
        vatMinor: 1840,
        taxableMinor: null,
        rate: 1.087,
        rateAsOf: '2026-06-29',
      },
      paymentQr: { dataUri: 'data:image/png;base64,AAAA' },
    });
    expect(html).toContain('Facture');
    expect(html).toContain('Indemnité forfaitaire pour frais de recouvrement : 40 €');
    expect(html).toContain('TVA non applicable, art. 293 B du CGI');
    expect(html).toContain('class="legal-mentions"');
    expect(html).toContain('TVA en EUR');
    expect(html).toContain('Taux de change : 1.087 (2026-06-29)');
    expect(html).toContain('ABCD1234-1');
    expect(html).toContain('<span class="k">Statut</span> sent');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('TVA 20% sur');
  });

  it('omits the status line when the caller says so (the delivered copy)', () => {
    const html = renderDocumentHtml({ ...usInvoiceInput(), printStatus: false });
    expect(html).not.toContain('>Status<');
  });
});

describe('quote and credit note use the same layout', () => {
  it('prints a quote with options as one labelled table and totals block per option', () => {
    const descriptor = buildQuoteDescriptor();
    const lines = [
      { description: 'Setup', quantity: 1, unitPrice: 10, vatRate: '0' },
      { description: 'Basic', quantity: 1, unitPrice: 100, vatRate: '0', option: 'Basic' },
      { description: 'Pro', quantity: 1, unitPrice: 200, vatRate: '0', option: 'Pro' },
    ];
    const data = { client: 'c', issueDate: '2026-10-15', currency: 'USD', lines };
    const total = (grossMinor: number) => ({
      currency: 'USD',
      lines: [],
      netMinor: grossMinor,
      vatMinor: 0,
      grossMinor,
      vatBreakdown: [],
      warnings: [],
      showVat: false,
    });
    const html = renderDocumentHtml({
      descriptor,
      instance: { id: 'q', status: 'sent', data, createdAt: new Date('2026-10-15'), displayNumber: 'Q-1' },
      company: { name: 'Acme' },
      referenceLabels: { client: 'Client' },
      optionGroups: {
        arrayFieldKey: 'lines',
        groupFieldKey: 'option',
        acceptedOption: 'Pro',
        groups: [
          { label: '', totals: total(1000), isCommon: true },
          { label: 'Basic', totals: total(11000) },
          { label: 'Pro', totals: total(21000) },
        ],
      },
    });
    expect(html).toContain('>Quote<');
    expect(html).toContain('Common to all options');
    expect(html.match(/class="option-group-heading"/g)).toHaveLength(3);
    expect(html).toContain('(Accepted)');
    expect(html).toContain('210.00 USD');
    expect(html).toContain('Total (including common lines)');
  });

  it('prints a linked credit note: the corrected-invoice sentence, the selected lines, the reason', () => {
    const descriptor = buildCreditNoteDescriptor();
    const selectedLine = { description: 'Refunded work', quantity: 1, unitPrice: 50, vatRate: '0' };
    const data = { invoice: 'inv-1', issueDate: '2026-10-20', currency: 'USD', reason: 'Client cancelled' };
    const invoiceLines = buildInvoiceDescriptor().fields.find((field) => field.key === 'lines');
    const html = renderDocumentHtml({
      descriptor,
      instance: { id: 'cn', status: 'sent', data, createdAt: new Date('2026-10-20'), displayNumber: 'CN-1' },
      company: { name: 'Acme' },
      referenceLabels: { client: 'Client' },
      correctedInvoice: { displayNumber: 'INV-2026-0007', issueDate: '2026-10-15' },
      resolvedRowSelections: { correctedLines: { field: invoiceLines!, rows: [selectedLine] } },
      businessLayout: { dateFormat: 'MM/dd/yyyy' },
    });
    expect(html).toContain('Credit note');
    expect(html).toContain('Corrects invoice INV-2026-0007 of 10/15/2026');
    expect(html).toContain('Refunded work');
    expect(html).toContain('Client cancelled');
  });
});

describe('formatLayoutDate', () => {
  it('formats the calendar part with the company pattern and never a time', () => {
    expect(formatLayoutDate('2026-10-15T23:59:59.000Z', 'MM/dd/yyyy')).toBe('10/15/2026');
    expect(formatLayoutDate('2026-10-15T15:12:39.662Z', 'dd.MM.yyyy')).toBe('15.10.2026');
  });
  it('falls back to yyyy-MM-dd for an absent or unknown pattern, prints non-dates as typed, hides empties', () => {
    expect(formatLayoutDate('2026-10-15T01:00:00Z')).toBe('2026-10-15');
    expect(formatLayoutDate('2026-10-15', 'not a pattern')).toBe('2026-10-15');
    expect(formatLayoutDate('next Friday', 'MM/dd/yyyy')).toBe('next Friday');
    expect(formatLayoutDate('')).toBeNull();
    expect(formatLayoutDate(undefined)).toBeNull();
  });
});

describe('formatAddressLines', () => {
  it('US style: street, then "City, ST ZIP, country"', () => {
    expect(
      formatAddressLines({
        address: '1021 E Lincolnway',
        city: 'Cheyenne',
        state: 'WY',
        postalCode: '82001',
        country: 'United States',
      }),
    ).toEqual(['1021 E Lincolnway', 'Cheyenne, WY 82001, United States']);
  });
  it('elsewhere: "postal code city", and empty parts vanish', () => {
    expect(
      formatAddressLines({
        address: '1 rue de Paris',
        postalCode: '75001',
        city: 'Paris',
        country: 'France',
      }),
    ).toEqual(['1 rue de Paris', '75001 Paris, France']);
    expect(formatAddressLines({})).toEqual([]);
  });
});
