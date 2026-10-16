import { describe, expect, it } from "vitest"

import { orderTransportsManualFirst, shouldOfferShareLinkAfter } from "./manual-send"

describe("shouldOfferShareLinkAfter", () => {
  it("offers the link after an invoice send when no transport is configured (default = manual)", () => {
    expect(shouldOfferShareLinkAfter("invoice", "send", { invoiceTransportId: null })).toBe(true)
    expect(shouldOfferShareLinkAfter("invoice", "send", {})).toBe(true)
  })

  it("offers it when manual is chosen explicitly", () => {
    expect(shouldOfferShareLinkAfter("invoice", "send", { invoiceTransportId: "manual" })).toBe(true)
  })

  it("does not when the company emails (or uses any other transport) — behaviour unchanged", () => {
    expect(shouldOfferShareLinkAfter("invoice", "send", { invoiceTransportId: "email" })).toBe(false)
    expect(shouldOfferShareLinkAfter("invoice", "send", { invoiceTransportId: "pdp" })).toBe(false)
  })

  it("does not before the company has loaded, nor for other actions or types", () => {
    expect(shouldOfferShareLinkAfter("invoice", "send", undefined)).toBe(false)
    expect(shouldOfferShareLinkAfter("invoice", "save-draft", {})).toBe(false)
    expect(shouldOfferShareLinkAfter("quote", "send", {})).toBe(false)
  })
})

describe("orderTransportsManualFirst", () => {
  it("lists manual first and keeps the others' relative order", () => {
    const ids = orderTransportsManualFirst([{ id: "email" }, { id: "pdp" }, { id: "manual" }]).map(
      (transport) => transport.id,
    )
    expect(ids).toEqual(["manual", "email", "pdp"])
  })

  it("is a no-op when manual is absent", () => {
    expect(orderTransportsManualFirst([{ id: "email" }])).toEqual([{ id: "email" }])
  })
})
