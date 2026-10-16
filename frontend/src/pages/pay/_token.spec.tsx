import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import PublicPayPage from "./[token]"

// Leading underscore keeps generouted from registering this file as a route.
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this as Response
    },
  } as Response
}

const INVOICE = {
  typeId: "invoice",
  displayNumber: "INV-1",
  status: "sent",
  issueDate: "2026-01-01",
  dueDate: "2026-01-31",
  currency: "EUR",
  sellerName: "Acme SAS",
  clientName: "Globex",
  lines: [{ description: "Consulting", quantity: 2, unitPrice: 50, lineTotal: 100 }],
  notes: "Thanks!\nNet 15 days. <b>x</b>",
  subtotal: 100,
  tax: 20,
  total: 120,
  paid: 0,
  credited: 0,
  outstanding: 120,
  canPayOnline: true,
}

function installFetch(summary: unknown, status = 200) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost")
    if (url.pathname === "/api/public/documents/tok" && (init?.method ?? "GET") === "GET") {
      return jsonResponse(summary, status)
    }
    if (url.pathname === "/api/public/documents/tok/checkout-session" && init?.method === "POST") {
      return jsonResponse({ checkoutUrl: "https://checkout.stripe.test/s" })
    }
    throw new Error(`Unmocked fetch in test: ${url.pathname}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

function renderPage(search = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/pay/tok${search}`]}>
        <Routes>
          <Route path="/pay/:token" element={<PublicPayPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("<PublicPayPage>", () => {
  it("shows the invoice and a pay button when online payment is available", async () => {
    installFetch(INVOICE)
    renderPage()

    expect(await screen.findByRole("heading", { level: 1, name: "Invoice INV-1" })).toBeTruthy()
    expect(screen.getByText("Consulting")).toBeTruthy()
    expect(screen.getByTestId("pay-button").textContent).toContain("Pay")
    expect(screen.getByTestId("pay-download-pdf").getAttribute("href")).toContain(
      "/api/public/documents/tok/pdf",
    )
  })

  it("shows the notes below the lines, as text with its line breaks", async () => {
    installFetch(INVOICE)
    renderPage()

    const notes = await screen.findByTestId("pay-notes")
    expect(notes.textContent).toBe("Thanks!\nNet 15 days. <b>x</b>")
    expect(notes.querySelector("b")).toBeNull()
    expect(notes.className).toContain("whitespace-pre-line")
  })

  it("renders no notes block when the invoice has none", async () => {
    installFetch({ ...INVOICE, notes: null })
    renderPage()

    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByTestId("pay-notes")).toBeNull()
  })

  it("hides the pay button when online payment is unavailable", async () => {
    installFetch({ ...INVOICE, canPayOnline: false })
    renderPage()

    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByTestId("pay-button")).toBeNull()
    expect(screen.getByTestId("pay-unavailable")).toBeTruthy()
  })

  it("shows Paid and no button for a settled invoice", async () => {
    installFetch({ ...INVOICE, paid: 120, outstanding: 0, canPayOnline: false })
    renderPage()

    expect(await screen.findByTestId("pay-settled")).toBeTruthy()
    expect(screen.queryByTestId("pay-button")).toBeNull()
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0)
  })

  it("shows the thank-you state after a successful return", async () => {
    installFetch(INVOICE)
    renderPage("?payment=success")

    const banner = await screen.findByTestId("pay-return-success")
    expect(banner.textContent).toContain("payment was received")
  })

  it("shows the cancelled state after a cancelled return", async () => {
    installFetch(INVOICE)
    renderPage("?payment=cancelled")

    expect((await screen.findByTestId("pay-return-cancelled")).textContent).toContain("cancelled")
  })

  it("shows the invalid-link state for an unknown token", async () => {
    installFetch({ message: "Link not found or expired." }, 404)
    renderPage()

    expect(await screen.findByText("This link is invalid or has expired")).toBeTruthy()
  })

  it("redirects to the checkout URL when the pay button is pressed", async () => {
    const fetchMock = installFetch(INVOICE)
    const assign = vi.fn()
    vi.stubGlobal("location", { ...window.location, assign })
    renderPage()

    fireEvent.click(await screen.findByTestId("pay-button"))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/checkout-session"),
      expect.objectContaining({ method: "POST" }),
    )
  })
})
