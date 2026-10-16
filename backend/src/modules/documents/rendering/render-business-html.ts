import { format } from 'date-fns';

import { ALLOWED_DATE_FORMATS } from '@/utils/date';
import { decimalsFor, fromMinor, toMinor } from '@/utils/financial';

import type { DocumentFieldDescriptor } from '../descriptors/types';
import { numberingDisplayState } from '../numbering/display-state';
import type { DocumentTotals } from '../totals/compute-totals';
import { defaultVatRateCatalog, findVatRateById } from '../vat-rates/registry';
import { fontFaceCssFor, fontStackFor } from './branding/font-catalog';
import { pdfChromeStrings, type PdfChromeStrings } from './language/pdf-chrome-strings';
import { DEFAULT_RENDER_LANGUAGE } from './language/supported-languages';
import type { RenderDocumentHtmlInput } from './render-html';
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BODY_FONT_STACK,
  escapeHtmlSafe,
  renderVatNationalCurrencyRows,
} from './render-html-shared';

/**
 * The dedicated layout of the three business documents a company hands to a client: invoice, quote
 * and credit note. The generic renderer (`render-html.ts`) prints EVERY descriptor field as its own
 * card in form order, which is the right default for an arbitrary (possibly third-party) type but a
 * poor invoice: two pages for six lines, a raw ISO timestamp as the date, an empty "Corrects invoice"
 * card, a lines table full of empty/zero columns, no client address.
 *
 * This layout changes PRESENTATION only, never what a document must say: the legal mentions block,
 * the country-mandated/tax-engine mentions inside it, the VAT-in-national-currency rows, the status
 * line (when the caller's policy prints it), the ATCUD, the SEPA QR, the payment methods and the
 * custom fields are all still emitted — only repositioned. An empty field renders nothing at all.
 *
 * Still a pure function of `RenderDocumentHtmlInput`: everything it needs beyond the descriptor loop
 * (addresses, identifiers, the date format, the origin document's number, the amount paid) arrives in
 * `input.businessLayout`, resolved by `render-instance-pdf.ts`.
 */
export const BUSINESS_LAYOUT_TYPE_IDS: ReadonlySet<string> = new Set(['invoice', 'quote', 'credit-note']);

export function usesBusinessLayout(typeId: string): boolean {
  return BUSINESS_LAYOUT_TYPE_IDS.has(typeId);
}

/** One party (seller or buyer) as the header prints it. Every part is optional but the name. */
export interface RenderPartyBlock {
  name: string;
  /** Already composed, one printed line each (street / locality + country). */
  addressLines: string[];
  /** `{ label: 'EIN', value: '12-3456789' }` — printed as "EIN: 12-3456789". */
  identifiers: { label: string; value: string }[];
  email?: string | null;
  phone?: string | null;
}

export interface BusinessLayoutContext {
  /** The company's `dateFormat` (a date-fns pattern from `ALLOWED_DATE_FORMATS`). Absent or unknown
   *  prints `yyyy-MM-dd`. A time component is NEVER printed, whatever the stored string carries. */
  dateFormat?: string | null;
  seller?: RenderPartyBlock;
  buyer?: RenderPartyBlock | null;
  /** The documents this one points at, by NUMBER (not the reference field's "client — date" picker
   *  label). `origin` = raised from it ("Ref: Quote Q-2026-0001"); `corrects` = an invoice correcting
   *  another. Entries with no number yet are skipped by the caller. */
  references?: { kind: 'origin' | 'corrects'; typeId: string; displayNumber: string }[];
  /** Sum of the payments recorded against this document, in ITS currency. Positive prints the
   *  "Paid" / "Amount due" rows. */
  paidMinor?: number;
}

export interface BusinessLayoutDeps {
  /** `render-html.ts`'s per-kind value formatter, injected rather than imported (that module imports
   *  this one to dispatch, so importing it back would be a runtime cycle). Used for custom fields only. */
  renderFieldValue: (
    field: DocumentFieldDescriptor,
    value: unknown,
    referenceLabels: Record<string, string>,
    data: Record<string, unknown>,
    strings: PdfChromeStrings,
  ) => string;
}

type Row = Record<string, unknown>;

const US_COUNTRY_NAME = /^(us|usa|united states( of america)?)$/i;

/**
 * Street line, then "locality, country" — at most two printed lines, in the order the destination's
 * post expects: US style ("Cheyenne, WY 82001") when the country is the United States, otherwise
 * "postal code city". Pure, so the loader and the specs share it.
 */
export function formatAddressLines(address: {
  address?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
}): string[] {
  const clean = (value: string | null | undefined) => (value ?? '').trim();
  const street = [clean(address.address), clean(address.addressLine2)].filter(Boolean).join(', ');
  const isUs =
    clean(address.countryCode).toUpperCase() === 'US' || US_COUNTRY_NAME.test(clean(address.country));
  const locality = isUs
    ? [clean(address.city), [clean(address.state), clean(address.postalCode)].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : [clean(address.postalCode), clean(address.city), clean(address.state)].filter(Boolean).join(' ');
  const second = [locality, clean(address.country)].filter(Boolean).join(', ');
  return [street, second].filter(Boolean);
}

/**
 * A stored date for the page: the company's pattern, never a time. The stored value is an ISO
 * timestamp (`2026-10-15T15:12:39.662Z`) or a bare date; only its calendar-date part is used, read
 * as written rather than shifted through a timezone (the same `slice(0, 10)` reading the reference
 * labels use). A value that is not a date at all is printed as typed — never silently dropped.
 */
export function formatLayoutDate(raw: unknown, dateFormat?: string | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return text;
  const pattern = dateFormat && ALLOWED_DATE_FORMATS.includes(dateFormat) ? dateFormat : 'yyyy-MM-dd';
  return format(date, pattern);
}

const isFilled = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

function rateOf(row: Row): number | null {
  const value = row.vatRate;
  if (!isFilled(value)) return null;
  const catalogRate = findVatRateById(defaultVatRateCatalog, String(value));
  if (catalogRate) return catalogRate.rate;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function discountOf(row: Row): number {
  const value = row.discountPercent;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Same arithmetic as `computeDocumentTotals` (price in minor units x quantity x (1 - discount)),
 *  so a printed line amount and the totals under it can never disagree. */
function lineNetMinor(row: Row, currency: string): number | null {
  const price = row.unitPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const quantity = typeof row.quantity === 'number' && Number.isFinite(row.quantity) ? row.quantity : 1;
  return Math.round(toMinor(price, currency) * quantity * (1 - discountOf(row) / 100));
}

function money(minor: number, currency: string): string {
  return fromMinor(minor, currency).toFixed(decimalsFor(currency));
}

interface LayoutContext {
  strings: PdfChromeStrings;
  currency: string;
  dateFormat?: string | null;
  showVat: boolean;
  workDateLabel: string;
}

/** The lines table. A column that carries nothing on any row is not printed at all. */
function renderLinesTable(rows: Row[], ctx: LayoutContext): string {
  const { strings, currency } = ctx;
  const t = strings.layout;
  const hasUnit = rows.some((row) => isFilled(row.unit));
  const hasDiscount = rows.some((row) => discountOf(row) > 0);
  const hasVat = ctx.showVat && rows.some((row) => (rateOf(row) ?? 0) > 0);
  const hasWorkDate = rows.some((row) => isFilled(row.date));
  const unitSuffix = currency ? ` (${escapeHtmlSafe(currency)})` : '';

  let html = '<table class="lines"><thead><tr>';
  html += `<th class="left">${escapeHtmlSafe(t.description)}</th>`;
  if (hasWorkDate) html += `<th class="left">${escapeHtmlSafe(ctx.workDateLabel)}</th>`;
  html += `<th class="num">${escapeHtmlSafe(t.quantity)}</th>`;
  if (hasUnit) html += `<th class="left">${escapeHtmlSafe(t.unit)}</th>`;
  html += `<th class="num">${escapeHtmlSafe(t.unitPrice)}${unitSuffix}</th>`;
  if (hasDiscount) html += `<th class="num">${escapeHtmlSafe(t.discount)}</th>`;
  if (hasVat) html += `<th class="num">${escapeHtmlSafe(t.vatRate)}</th>`;
  html += `<th class="num">${escapeHtmlSafe(t.amount)}${unitSuffix}</th>`;
  html += '</tr></thead><tbody>';

  for (const row of rows) {
    const unit = isFilled(row.unit) ? String(row.unit) : '';
    const price = typeof row.unitPrice === 'number' ? money(toMinor(row.unitPrice, currency), currency) : '—';
    const net = lineNetMinor(row, currency);
    const rate = rateOf(row);
    html += '<tr>';
    html += `<td class="left desc">${escapeHtmlSafe(isFilled(row.description) ? String(row.description) : '—')}</td>`;
    if (hasWorkDate) {
      html += `<td class="left">${escapeHtmlSafe(formatLayoutDate(row.date, ctx.dateFormat) ?? '')}</td>`;
    }
    html += `<td class="num">${escapeHtmlSafe(isFilled(row.quantity) ? String(row.quantity) : '—')}</td>`;
    if (hasUnit)
      html += `<td class="left">${escapeHtmlSafe(strings.suggestedValueLabels[unit] ?? unit)}</td>`;
    html += `<td class="num">${escapeHtmlSafe(price)}</td>`;
    if (hasDiscount) {
      html += `<td class="num">${discountOf(row) > 0 ? `${escapeHtmlSafe(String(discountOf(row)))}%` : ''}</td>`;
    }
    if (hasVat) html += `<td class="num">${rate === null ? '—' : `${escapeHtmlSafe(String(rate))}%`}</td>`;
    html += `<td class="num">${escapeHtmlSafe(net === null ? '—' : money(net, currency))}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/**
 * Subtotal / VAT rows only when VAT is meaningful (some rate above zero and the seller not exempt) —
 * otherwise a single Total row, with no "VAT 0" noise. The tax engine's own warnings are internal
 * diagnostics, not content for the client, and are not printed here.
 */
function renderTotalsBlock(
  totals: DocumentTotals,
  strings: PdfChromeStrings,
  options: {
    paidMinor?: number;
    totalLabel?: string;
    vatNationalCurrency?: RenderDocumentHtmlInput['vatNationalCurrency'];
  },
): string {
  const currency = totals.currency || '';
  const display = (minor: number) => `${money(minor, currency || 'EUR')} ${currency || '—'}`;
  const showVatRows = totals.showVat !== false && totals.vatBreakdown.some((entry) => entry.ratePercent > 0);
  const row = (label: string, amount: string, cls = '') =>
    `<div class="totals-row${cls ? ` ${cls}` : ''}"><span>${escapeHtmlSafe(label)}</span><span class="totals-amount">${escapeHtmlSafe(amount)}</span></div>`;

  let html = '<div class="totals">';
  if (showVatRows) {
    html += row(strings.layout.subtotal, display(totals.netMinor));
    for (const entry of totals.vatBreakdown) {
      html += row(
        strings.vatOn(entry.ratePercent.toString(), display(entry.baseMinor)),
        display(entry.vatMinor),
      );
    }
  }
  html += row(options.totalLabel ?? strings.total, display(totals.grossMinor), 'summary');
  if (options.paidMinor && options.paidMinor > 0) {
    html += row(strings.layout.paid, `-${display(options.paidMinor)}`);
    html += row(
      strings.layout.amountDue,
      display(Math.max(0, totals.grossMinor - options.paidMinor)),
      'summary',
    );
  }
  if (options.vatNationalCurrency)
    html += renderVatNationalCurrencyRows(options.vatNationalCurrency, strings);
  html += '</div>';
  return html;
}

function renderParty(party: RenderPartyBlock, nameClass = 'party-name'): string {
  let html = `<div class="${nameClass}">${escapeHtmlSafe(party.name)}</div>`;
  for (const line of party.addressLines) html += `<div class="party-line">${escapeHtmlSafe(line)}</div>`;
  for (const identifier of party.identifiers) {
    html += `<div class="party-line">${escapeHtmlSafe(`${identifier.label}: ${identifier.value}`)}</div>`;
  }
  const contact = [party.email, party.phone].filter((value): value is string => !!value);
  if (contact.length > 0) html += `<div class="party-line">${escapeHtmlSafe(contact.join(' · '))}</div>`;
  return html;
}

function titleFor(typeId: string, fallback: string, strings: PdfChromeStrings): string {
  switch (typeId) {
    case 'invoice':
      return strings.layout.invoiceTitle;
    case 'quote':
      return strings.layout.quoteTitle;
    case 'credit-note':
      return strings.layout.creditNoteTitle;
    default:
      return fallback;
  }
}

export function renderBusinessDocumentHtml(input: RenderDocumentHtmlInput, deps: BusinessLayoutDeps): string {
  const { descriptor, instance, company, referenceLabels } = input;
  const strings = pdfChromeStrings(input.language ?? DEFAULT_RENDER_LANGUAGE);
  const ctxIn = input.businessLayout ?? {};
  const data = instance.data;

  const accentColor = input.branding?.accentColor || DEFAULT_ACCENT_COLOR;
  const bodyFontStack = fontStackFor(input.branding?.font) ?? DEFAULT_BODY_FONT_STACK;
  const fontFaceCss = fontFaceCssFor(input.branding?.font);
  const logoDataUri = input.branding?.logoDataUri || null;

  const currency =
    (typeof data.currency === 'string' && data.currency) ||
    input.totals?.currency ||
    input.optionGroups?.groups[0]?.totals.currency ||
    '';

  const seller: RenderPartyBlock = ctxIn.seller ?? {
    name: company.name,
    addressLines: formatAddressLines(company),
    identifiers: [],
  };
  const buyer: RenderPartyBlock | null =
    ctxIn.buyer ??
    (referenceLabels.client ? { name: referenceLabels.client, addressLines: [], identifiers: [] } : null);

  const issueDate = formatLayoutDate(data.issueDate ?? instance.createdAt.toISOString(), ctxIn.dateFormat);
  const dueDate = formatLayoutDate(data.dueDate, ctxIn.dateFormat);

  const numberText = descriptor.numbering
    ? (instance.displayNumber ??
      (numberingDisplayState(descriptor, instance) === 'awaiting'
        ? strings.draftNoNumberYet
        : strings.issuedWithoutNumber))
    : '';

  // Lines: the document's own `lines`, plus (credit note) the corrected invoice's selected lines the
  // caller resolved — the same rows the generic renderer printed as the rowSelection table.
  const ownRows = Array.isArray(data.lines) ? (data.lines as Row[]) : [];
  const selectedRows = Object.values(input.resolvedRowSelections ?? {}).flatMap((entry) => entry.rows);
  const allRows = [...selectedRows, ...ownRows];

  const showVat = input.totals ? input.totals.showVat !== false : true;
  const workDateLabel =
    descriptor.fields.find((field) => field.key === 'lines')?.fields?.find((sub) => sub.key === 'date')
      ?.label ?? 'Work date';
  const layoutCtx: LayoutContext = {
    strings,
    currency,
    dateFormat: ctxIn.dateFormat,
    showVat,
    workDateLabel,
  };

  let body = '';

  // --- header: seller left, document block right
  const docRows: string[] = [];
  if (issueDate)
    docRows.push(
      `<div><span class="k">${escapeHtmlSafe(strings.date)}</span> ${escapeHtmlSafe(issueDate)}</div>`,
    );
  if (dueDate)
    docRows.push(
      `<div><span class="k">${escapeHtmlSafe(strings.layout.dueDate)}</span> ${escapeHtmlSafe(dueDate)}</div>`,
    );
  if (input.printStatus !== false) {
    docRows.push(
      `<div><span class="k">${escapeHtmlSafe(strings.status)}</span> ${escapeHtmlSafe(instance.status)}</div>`,
    );
  }

  body += `
    <div class="top">
      <div class="seller">
        ${logoDataUri ? `<img class="logo" src="${escapeHtmlSafe(logoDataUri)}" alt="">` : ''}
        ${renderParty(seller, 'seller-name')}
      </div>
      <div class="docinfo">
        <div class="doc-title">${escapeHtmlSafe(titleFor(descriptor.id, descriptor.label, strings))}</div>
        ${numberText ? `<div class="doc-number">${escapeHtmlSafe(numberText)}</div>` : ''}
        ${instance.atcud ? `<div class="doc-atcud">${escapeHtmlSafe(instance.atcud)}</div>` : ''}
        <div class="doc-meta">${docRows.join('')}</div>
      </div>
    </div>
`;

  // --- bill to
  if (buyer) {
    body += `
    <div class="bill-to">
      <div class="section-label">${escapeHtmlSafe(strings.layout.billTo)}</div>
      ${renderParty(buyer)}
    </div>
`;
  }

  // --- small reference lines, each only when present
  const refs: string[] = [];
  if (input.correctedInvoice) {
    // Issue #507: a linked credit note must name the corrected invoice by number AND date.
    const correctedDate = formatLayoutDate(input.correctedInvoice.issueDate, ctxIn.dateFormat) ?? '-';
    refs.push(
      strings.correctsInvoice(
        escapeHtmlSafe(input.correctedInvoice.displayNumber ?? strings.issuedWithoutNumber),
        escapeHtmlSafe(correctedDate),
      ),
    );
  }
  for (const reference of ctxIn.references ?? []) {
    const typeTitle = titleFor(reference.typeId, reference.typeId, strings);
    refs.push(`${escapeHtmlSafe(`${strings.layout.ref}: ${typeTitle} ${reference.displayNumber}`)}`);
  }
  if (isFilled(data.clientReference)) {
    refs.push(escapeHtmlSafe(`${strings.layout.clientReference}: ${String(data.clientReference)}`));
  }
  if (refs.length > 0) {
    body += `    <div class="refs">${refs.map((ref) => `<div>${ref}</div>`).join('')}</div>\n`;
  }

  // --- lines (+ totals)
  const optionGroups = input.optionGroups;
  if (optionGroups) {
    const hasCommonGroup = optionGroups.groups.some((group) => group.isCommon);
    const groupKey = optionGroups.groupFieldKey;
    for (const group of optionGroups.groups) {
      const rows = ownRows.filter((row) => {
        const raw = row[groupKey];
        return group.isCommon
          ? typeof raw !== 'string' || raw.trim() === ''
          : typeof raw === 'string' && raw.trim() === group.label;
      });
      const isAccepted = !group.isCommon && optionGroups.acceptedOption === group.label;
      const heading = group.isCommon ? strings.commonToAllOptionsHeading : group.label;
      body += `
    <div class="option-group">
      <div class="option-group-heading" style="color: ${accentColor};">${escapeHtmlSafe(heading)}${
        isAccepted
          ? `<span class="accepted-badge">(${escapeHtmlSafe(strings.acceptedOptionBadge)})</span>`
          : ''
      }</div>
      ${renderLinesTable(rows, { ...layoutCtx, showVat: group.totals.showVat !== false })}
      ${
        group.isCommon
          ? ''
          : renderTotalsBlock(group.totals, strings, {
              totalLabel: hasCommonGroup ? strings.totalIncludingCommonLines : undefined,
            })
      }
    </div>
`;
    }
  } else {
    if (allRows.length > 0) body += `    ${renderLinesTable(allRows, layoutCtx)}\n`;
    if (input.totals) {
      body += `    ${renderTotalsBlock(input.totals, strings, {
        paidMinor: ctxIn.paidMinor,
        vatNationalCurrency: input.vatNationalCurrency,
      })}\n`;
    }
  }

  // --- reason (credit note) and notes: line breaks preserved, ordinary font
  for (const [key, label] of [
    ['reason', strings.layout.reason],
    ['notes', strings.layout.notes],
  ] as const) {
    if (isFilled(data[key])) {
      body += `
    <div class="notes">
      <div class="section-label">${escapeHtmlSafe(label)}</div>
      <div class="notes-body">${escapeHtmlSafe(String(data[key]))}</div>
    </div>
`;
    }
  }

  // --- payment: methods and the SEPA QR
  const methods = input.paymentMethods ?? [];
  if (methods.length > 0 || input.paymentQr) {
    body += `
    <div class="payment">
      <div class="payment-main">
`;
    if (methods.length > 0) {
      body += `        <div class="section-label">${escapeHtmlSafe(strings.paymentMethodsHeading)}</div>\n`;
      for (const method of methods) {
        body += `        <div class="payment-method-item">\n          <div class="payment-method-label">${escapeHtmlSafe(method.label)}</div>\n`;
        for (const line of method.lines) {
          body += `          <div class="payment-method-line">${escapeHtmlSafe(line)}</div>\n`;
        }
        if (method.link)
          body += `          <div class="payment-method-link">${escapeHtmlSafe(method.link)}</div>\n`;
        body += '        </div>\n';
      }
    }
    body += '      </div>\n';
    if (input.paymentQr) {
      body += `      <div class="payment-qr-section">
        <img class="payment-qr-image" src="${escapeHtmlSafe(input.paymentQr.dataUri)}" alt="SEPA payment QR code" width="110" height="110">
        <div class="payment-qr-label">${escapeHtmlSafe(strings.scanToPaySepa)}</div>
      </div>
`;
    }
    body += '    </div>\n';
  }

  // --- footer: statutory mentions (country-mandated + tax-engine), then custom fields
  if (input.legalMentions && input.legalMentions.length > 0) {
    body += '    <div class="legal-mentions">\n';
    for (const mention of input.legalMentions) {
      body += `      <div class="legal-mention-item">${escapeHtmlSafe(mention.text)}</div>\n`;
    }
    body += '    </div>\n';
  }
  if (input.customFields && input.customFields.length > 0) {
    body += `    <div class="custom-fields-section">\n      <div class="section-label">${escapeHtmlSafe(strings.customFieldsHeading)}</div>\n`;
    for (const entry of input.customFields) {
      const rendered = deps.renderFieldValue(entry.field, entry.value, referenceLabels, data, strings);
      body += `      <div class="custom-field-item"><span class="custom-field-label">${escapeHtmlSafe(entry.field.label)}</span><span>${rendered}</span></div>\n`;
    }
    body += '    </div>\n';
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtmlSafe(titleFor(descriptor.id, descriptor.label, strings))}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: ${bodyFontStack}; font-size: 12px; line-height: 1.4; color: #222; background: white; }
    .container { max-width: 800px; margin: 0 auto; }
    .top { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 14px; border-bottom: 2px solid ${accentColor}; }
    .seller { flex: 1 1 auto; }
    .logo { display: block; max-height: 56px; max-width: 220px; margin-bottom: 8px; }
    .seller-name { font-size: 16px; font-weight: bold; margin-bottom: 2px; }
    .party-name { font-size: 13px; font-weight: bold; margin-bottom: 1px; }
    .party-line { color: #555; }
    .docinfo { text-align: right; flex: 0 0 auto; }
    .doc-title { font-size: 24px; font-weight: bold; color: ${accentColor}; line-height: 1.1; }
    .doc-number { font-size: 14px; margin-top: 2px; }
    .doc-atcud { font-size: 11px; color: #555; font-family: monospace; }
    .doc-meta { margin-top: 8px; color: #333; }
    .doc-meta .k { color: #777; margin-right: 6px; }
    .section-label { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: ${accentColor}; margin-bottom: 3px; }
    .bill-to { margin-top: 14px; }
    .refs { margin-top: 10px; font-size: 11px; color: #555; }
    table.lines { width: 100%; border-collapse: collapse; margin-top: 16px; }
    table.lines th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #555; padding: 5px 6px; border-bottom: 1.5px solid #bbb; }
    table.lines td { padding: 6px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
    table.lines .left { text-align: left; }
    table.lines .num { text-align: right; white-space: nowrap; }
    table.lines .desc { white-space: pre-line; word-break: break-word; }
    table.lines tr { page-break-inside: avoid; }
    .totals { width: 55%; margin: 10px 0 0 auto; page-break-inside: avoid; }
    .totals-row { display: flex; justify-content: space-between; gap: 24px; padding: 3px 0; font-size: 12px; }
    .totals-row.summary { font-weight: bold; font-size: 13px; border-top: 1.5px solid #333; margin-top: 3px; padding-top: 5px; }
    .totals-amount { text-align: right; white-space: nowrap; }
    .totals-row.totals-converted { color: #555; font-style: italic; }
    .totals-row.totals-converted-rate { justify-content: flex-end; }
    .totals-note { font-size: 10px; color: #777; }
    .option-group { margin-top: 18px; }
    .option-group-heading { font-weight: bold; font-size: 13px; }
    .accepted-badge { font-weight: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 8px; }
    .notes { margin-top: 16px; page-break-inside: avoid; }
    .notes-body { white-space: pre-wrap; word-break: break-word; }
    .payment { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-top: 16px; padding: 10px; background: #f7f7f7; border-radius: 4px; page-break-inside: avoid; }
    .payment-method-item { margin-top: 4px; }
    .payment-method-label { font-weight: bold; }
    .payment-method-line { font-size: 11px; color: #555; }
    .payment-method-link { font-size: 11px; color: #1a5fb4; word-break: break-all; }
    .payment-qr-section { text-align: center; flex: 0 0 auto; }
    .payment-qr-label { font-size: 10px; color: #555; }
    .legal-mentions { margin-top: 16px; padding-top: 8px; border-top: 1px solid #ddd; }
    .legal-mention-item { font-size: 10px; color: #555; margin-bottom: 3px; }
    .custom-fields-section { margin-top: 14px; padding-top: 8px; border-top: 1px solid #ddd; }
    .custom-field-item { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
    .custom-field-label { color: #666; }
  </style>${fontFaceCss ? `\n  <style>${fontFaceCss}</style>` : ''}
</head>
<body>
  <div class="container">${body}
  </div>
</body>
</html>
`;
}
