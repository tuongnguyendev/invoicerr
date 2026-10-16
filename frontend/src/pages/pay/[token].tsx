import { AlertTriangle, CheckCircle2, Download, FileWarning } from "lucide-react"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useParams, useSearchParams } from "react-router"

import { DocumentStatusBadge } from "@/components/documents/document-status-badge"
import { PublicPageShell } from "@/components/public-page-shell"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useCreatePublicInvoiceCheckout, usePublicInvoice } from "@/hooks/queries"
import { ApiError } from "@/hooks/use-api-query"

/** After a `?payment=success` return the webhook may still be in flight: re-ask for the balance a few
 *  times, then stop — the banner already says it can take a moment. */
const SUCCESS_REFETCH_MS = 3000
const SUCCESS_REFETCH_MAX = 5

function formatAmount(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount)
  } catch {
    // An unknown currency code makes Intl throw — show the bare number rather than crash the page.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * The customer pay page — the target of an invoice's share link (`/pay/:token`). A TOP-LEVEL page
 * (`pages/pay/`, no `(app)` group), like `pages/portal/`: it must render identically whether or not a
 * staff member is signed in on the same browser, and it never reads the session.
 *
 * Read-only: the invoice as the PDF shows it, the outstanding balance, and — when the backend says
 * `canPayOnline` — one button that opens the provider's hosted Checkout in THIS tab (the return URL
 * brings the customer back here). The `?payment=` flag is only a courtesy banner, never proof of
 * payment: the verified webhook is what marks the invoice paid, which is why a `success` return polls
 * the summary for a short while instead of trusting the flag.
 */
export default function PublicPayPage() {
  const { t, i18n } = useTranslation()
  const { token = "" } = useParams()
  const [searchParams] = useSearchParams()
  const payment = searchParams.get("payment")

  const { data: invoice, isLoading, error, refetch } = usePublicInvoice(token)
  const checkout = useCreatePublicInvoiceCheckout(token)

  const settled = !!invoice && invoice.outstanding <= 0 && invoice.total > 0
  const refetchCount = useRef(0)
  useEffect(() => {
    if (payment !== "success" || !invoice || settled) return
    const timer = setInterval(() => {
      refetchCount.current += 1
      if (refetchCount.current > SUCCESS_REFETCH_MAX) {
        clearInterval(timer)
        return
      }
      void refetch()
    }, SUCCESS_REFETCH_MS)
    return () => clearInterval(timer)
  }, [payment, invoice, settled, refetch])

  if (isLoading) {
    return (
      <PublicPageShell dataCy="pay-page">
        <Skeleton className="h-64 w-full" />
      </PublicPageShell>
    )
  }

  if (error || !invoice) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <PublicPageShell dataCy="pay-page" width="narrow">
        <EmptyState
          icon={FileWarning}
          tone="destructive"
          title={notFound ? t("publicPay.invalidTitle") : t("publicPay.loadErrorTitle")}
          description={notFound ? t("publicPay.invalidDescription") : t("publicPay.loadErrorDescription")}
        />
      </PublicPageShell>
    )
  }

  const money = (amount: number) => formatAmount(amount, invoice.currency, i18n.language)
  const pdfHref = `${import.meta.env.VITE_BACKEND_URL || ""}/api/public/documents/${encodeURIComponent(token)}/pdf`

  const handlePay = () => {
    checkout.mutate(undefined, {
      onSuccess: (data) => window.location.assign(data.checkoutUrl),
    })
  }

  return (
    <PublicPageShell company={{ name: invoice.sellerName }} dataCy="pay-page">
      <div className="space-y-6">
        {payment === "success" && (
          <Alert variant="success" data-cy="pay-return-success">
            <CheckCircle2 />
            <AlertTitle>{settled ? t("publicPay.returnPaid") : t("publicPay.returnSuccess")}</AlertTitle>
          </Alert>
        )}
        {payment === "cancelled" && !settled && (
          <Alert variant="warning" data-cy="pay-return-cancelled">
            <AlertTriangle />
            <AlertTitle>{t("publicPay.returnCancelled")}</AlertTitle>
          </Alert>
        )}

        <section
          className="space-y-4 rounded-lg border bg-card p-4 sm:p-6"
          aria-labelledby="pay-invoice-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h1 id="pay-invoice-title" className="font-heading text-2xl font-semibold tracking-tight">
                {invoice.displayNumber
                  ? t("publicPay.title", { number: invoice.displayNumber })
                  : t("publicPay.titleNoNumber")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("publicPay.from", { name: invoice.sellerName })}
              </p>
            </div>
            {settled ? (
              <DocumentStatusBadge status="paid" label={t("publicPay.paidBadge")} />
            ) : (
              <DocumentStatusBadge status={invoice.status} />
            )}
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            {invoice.clientName && (
              <div>
                <dt className="text-muted-foreground">{t("publicPay.billedTo")}</dt>
                <dd className="font-medium">{invoice.clientName}</dd>
              </div>
            )}
            {invoice.issueDate && (
              <div>
                <dt className="text-muted-foreground">{t("publicPay.issued")}</dt>
                <dd className="font-medium">{invoice.issueDate}</dd>
              </div>
            )}
            {invoice.dueDate && (
              <div>
                <dt className="text-muted-foreground">{t("publicPay.due")}</dt>
                <dd className="font-medium">{invoice.dueDate}</dd>
              </div>
            )}
          </dl>

          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{t("publicPay.linesCaption")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("publicPay.columns.description")}</TableHead>
                  <TableHead scope="col" className="text-end">
                    {t("publicPay.columns.quantity")}
                  </TableHead>
                  <TableHead scope="col" className="text-end">
                    {t("publicPay.columns.unitPrice")}
                  </TableHead>
                  <TableHead scope="col" className="text-end">
                    {t("publicPay.columns.total")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: read-only list, rows have no id
                  <TableRow key={index}>
                    <TableCell className="whitespace-normal">{line.description}</TableCell>
                    <TableCell className="text-end">{line.quantity}</TableCell>
                    <TableCell className="text-end">{money(line.unitPrice)}</TableCell>
                    <TableCell className="text-end">{money(line.lineTotal)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <dl className="ms-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("publicPay.subtotal")}</dt>
              <dd>{money(invoice.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("publicPay.tax")}</dt>
              <dd>{money(invoice.tax)}</dd>
            </div>
            <div className="flex justify-between gap-4 font-semibold">
              <dt>{t("publicPay.total")}</dt>
              <dd>{money(invoice.total)}</dd>
            </div>
            {invoice.paid > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("publicPay.paid")}</dt>
                <dd>{money(invoice.paid)}</dd>
              </div>
            )}
            {invoice.credited > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("publicPay.credited")}</dt>
                <dd>{money(invoice.credited)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>{t("publicPay.outstanding")}</dt>
              <dd data-cy="pay-outstanding">{money(invoice.outstanding)}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {invoice.canPayOnline && !settled ? (
            <Button
              type="button"
              size="lg"
              className="w-full sm:w-auto"
              loading={checkout.isPending}
              onClick={handlePay}
              dataCy="pay-button"
            >
              {t("publicPay.payButton", { amount: money(invoice.outstanding) })}
            </Button>
          ) : settled ? (
            <p className="flex items-center gap-2 text-sm font-medium" data-cy="pay-settled">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              {t("publicPay.settled")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-cy="pay-unavailable">
              {t("publicPay.unavailable")}
            </p>
          )}
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <a href={pdfHref} target="_blank" rel="noopener noreferrer" data-cy="pay-download-pdf">
              <Download aria-hidden="true" />
              {t("publicPay.downloadPdf")}
            </a>
          </Button>
        </div>

        {checkout.error && (
          <Alert variant="destructive" role="alert" data-cy="pay-error">
            <AlertTriangle />
            <AlertTitle>
              {checkout.error.status === 501 ? t("publicPay.notConnected") : t("publicPay.payError")}
            </AlertTitle>
          </Alert>
        )}
      </div>
    </PublicPageShell>
  )
}
