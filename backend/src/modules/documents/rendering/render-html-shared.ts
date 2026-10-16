import { decimalsFor, fromMinor } from '@/utils/financial';
import type { DocumentTotals } from '../totals/compute-totals';
import type { PdfChromeStrings } from './language/pdf-chrome-strings';
import type { RenderDocumentHtmlInput } from './render-html';

/**
 * Helpers shared by the generic renderer (`render-html.ts`) and the dedicated invoice/quote/credit-note
 * layout (`render-business-html.ts`). Extracted into their own module so the two can both depend on
 * them without importing each other at runtime (`render-html.ts` dispatches to the business layout).
 */

/** The EXACT pre-branding values (chantier B, 2026-09-15) — what every render used unconditionally
 *  before `RenderDocumentHtmlInput.branding` existed, and what a company with no branding set still
 *  gets, verbatim: see `renderDocumentHtml`'s own header for the byte-for-byte guarantee this pair
 *  exists to uphold. Never read anywhere else — `fontStackFor`/an explicit `accentColor` are the only
 *  two ways to override either. */
export const DEFAULT_ACCENT_COLOR = '#007bff';
export const DEFAULT_BODY_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Escapes HTML special characters — applied to ALL values from data to prevent injection.
 */
function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

// Fallback for Node.js environment where document doesn't exist
export function escapeHtmlNode(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeHtmlSafe(value: string): string {
  try {
    return escapeHtml(value);
  } catch {
    return escapeHtmlNode(value);
  }
}

/** The SAME emptiness test `hideWhenEmpty`'s top-level check (further below) and
 *  `validate.ts#isMissing` both already use — undefined/null/'' only, so a legitimately falsy value
 *  (0, false) is never treated as empty. Named and exported from neither: this is the one place an
 *  'array' row needs it too (see the 'array' case's own subfield-column filter, just below), so it
 *  is a local helper shared by both call sites in THIS file rather than duplicated inline twice. */
export function isEmptyFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The net/VAT-breakdown/gross/warnings ROWS shared by the ordinary single totals section AND, since
 * issue #373 ("quotes with options"), each per-option group's own mini totals block below - extracted
 * so the two never drift apart on rounding, VAT-aggregation, or the `showVat` rule (see
 * `DocumentTotals.showVat`'s own header, compute-totals.ts). Returns the INNER rows only, not the
 * outer `.totals-section`/label wrapper - callers differ on that (the global section gets its own
 * heading; a group gets one heading for the whole option, not a second "Totals" label repeated inside
 * it), so wrapping stays each caller's own job.
 */
export function renderTotalsRows(
  totals: DocumentTotals,
  strings: PdfChromeStrings,
  // Issue #373 follow-up ("no meaningless common total") - true only for a REAL option's own block,
  // and only when a common group exists alongside it (`renderOptionGroupsField`'s own call site):
  // swaps the gross row's label for `strings.totalIncludingCommonLines` so a reader can tell this
  // figure already folds the common lines in, without the common group printing a total of its own
  // to point back at. Never true for the ordinary single-total section, or for a common group's own
  // (line-only) block, which no longer calls this function for its totals at all.
  totalLabelIncludesCommon = false,
): string {
  const currency = totals.currency || '—';
  const decimals = decimalsFor(currency);
  const showVat = totals.showVat !== false;

  let html = '';
  if (showVat) {
    const netDisplay = `${fromMinor(totals.netMinor, currency).toFixed(decimals)} ${currency}`;
    html += `
      <div class="totals-row">
        <span>${escapeHtmlSafe(strings.net)}</span>
        <span class="totals-amount">${escapeHtmlSafe(netDisplay)}</span>
      </div>
`;
    for (const entry of totals.vatBreakdown) {
      const baseDisplay = `${fromMinor(entry.baseMinor, currency).toFixed(decimals)} ${currency}`;
      const vatDisplay = `${fromMinor(entry.vatMinor, currency).toFixed(decimals)} ${currency}`;
      html += `
      <div class="totals-row">
        <span>${escapeHtmlSafe(strings.vatOn(entry.ratePercent.toString(), baseDisplay))}</span>
        <span class="totals-amount">${escapeHtmlSafe(vatDisplay)}</span>
      </div>
`;
    }
  }

  const grossDisplay = `${fromMinor(totals.grossMinor, currency).toFixed(decimals)} ${currency}`;
  const grossLabel = totalLabelIncludesCommon ? strings.totalIncludingCommonLines : strings.total;
  html += `
      <div class="totals-row summary">
        <span>${escapeHtmlSafe(grossLabel)}</span>
        <span class="totals-amount">${escapeHtmlSafe(grossDisplay)}</span>
      </div>
`;

  if (totals.warnings.length > 0) {
    html += `
      <div class="warnings-section">
`;
    for (const warning of totals.warnings) {
      html += `        <div class="warning-item">${escapeHtmlSafe(warning)}</div>\n`;
    }
    html += `      </div>\n`;
  }

  return html;
}

/**
 * Issue #517: the extra rows printed under the ordinary totals section when the seller's own
 * country required its VAT (and, for Italy, its taxable amount too) converted into the country's own
 * national currency (`RenderDocumentHtmlInput.vatNationalCurrency`'s own header). A tiny, separate
 * function rather than folded into `renderTotalsRows` above: that one is SHARED with each per-option
 * group's own mini totals block, and this fact is a document-level one, never a per-option one (see
 * that input's own header). Keeping this separate is what makes it trivially impossible to print
 * this once per option by accident.
 */
export function renderVatNationalCurrencyRows(
  vatNationalCurrency: NonNullable<RenderDocumentHtmlInput['vatNationalCurrency']>,
  strings: PdfChromeStrings,
): string {
  const { currency, vatMinor, taxableMinor, rate, rateAsOf } = vatNationalCurrency;
  const decimals = decimalsFor(currency);
  let html = '';

  if (taxableMinor !== null) {
    const taxableDisplay = `${fromMinor(taxableMinor, currency).toFixed(decimals)} ${currency}`;
    html += `
      <div class="totals-row totals-converted">
        <span>${escapeHtmlSafe(strings.taxableInNationalCurrency(currency))}</span>
        <span class="totals-amount">${escapeHtmlSafe(taxableDisplay)}</span>
      </div>
`;
  }

  const vatDisplay = `${fromMinor(vatMinor, currency).toFixed(decimals)} ${currency}`;
  html += `
      <div class="totals-row totals-converted">
        <span>${escapeHtmlSafe(strings.vatInNationalCurrency(currency))}</span>
        <span class="totals-amount">${escapeHtmlSafe(vatDisplay)}</span>
      </div>
      <div class="totals-row totals-converted-rate">
        <span class="totals-note">${escapeHtmlSafe(strings.exchangeRate(String(rate), rateAsOf))}</span>
      </div>
`;

  return html;
}
