import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentDetailActions } from "./document-detail"
import type { DocumentActionDescriptor, DocumentInstance, DocumentTypeDescriptor } from "./types"

// The dialogs are only mounted once opened; stubbed so this suite stays about the MENU.
vi.mock("@/components/documents/email-client-dialog", () => ({
  EmailClientDialog: () => <div data-cy="email-client-dialog-stub" />,
}))
vi.mock("@/components/documents/share-link-dialog", () => ({ ShareLinkDialog: () => null }))

// Radix's menu opens on pointerdown and measures with ResizeObserver; jsdom has neither.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  class PointerEventPolyfill extends MouseEvent {
    pointerId = 1
    pointerType = "mouse"
    isPrimary = true
  }
  vi.stubGlobal("PointerEvent", PointerEventPolyfill)
})

const action = (id: string, label: string, availableWhen: string[]): DocumentActionDescriptor => ({
  id,
  label,
  availableWhen,
})

const invoice: DocumentTypeDescriptor = {
  id: "invoice",
  label: "Invoice",
  fields: [],
  actions: [
    action("duplicate", "Duplicate", ["sent"]),
    action("share-link", "Share link", ["sent"]),
    action("email-client", "Email to client", ["sent", "send_failed"]),
  ],
} as DocumentTypeDescriptor

const instance = (status: string) =>
  ({ id: "inv-1", typeId: "invoice", status, data: { client: "c-1" } }) as unknown as DocumentInstance

function openMenu(status: string) {
  const state = { currentStatus: status, runner: { handleAction: vi.fn() } }
  render(
    <DocumentDetailActions
      descriptor={invoice}
      instance={instance(status)}
      state={state as never}
      primary={undefined}
      secondary={[invoice.actions[0]]}
      isProcessing={false}
    />,
  )
  fireEvent.pointerDown(screen.getByTestId("document-actions-menu"), { button: 0, ctrlKey: false })
}

describe("<DocumentDetailActions> - Actions menu", () => {
  it("puts Share link and Email to client first, then a separator, then the rest", () => {
    openMenu("sent")

    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim())
    expect(items.slice(0, 2)).toEqual(["Share link", "Email to client"])
    expect(items.indexOf("Duplicate")).toBeGreaterThan(1)
    expect(items.indexOf("Download PDF")).toBeGreaterThan(items.indexOf("Duplicate"))

    const menu = screen.getByTestId("document-actions-menu-content")
    const children = Array.from(menu.children)
    const separator = children.findIndex((el) => el.getAttribute("role") === "separator")
    const emailIndex = children.findIndex((el) => el.textContent?.includes("Email to client"))
    const duplicateIndex = children.findIndex((el) => el.textContent?.includes("Duplicate"))
    expect(emailIndex).toBeLessThan(separator)
    expect(separator).toBeLessThan(duplicateIndex)
  })

  it("opens the confirm dialog from Email to client", () => {
    openMenu("sent")
    fireEvent.click(screen.getByTestId("document-email-client-button"))
    expect(screen.getByTestId("email-client-dialog-stub")).toBeInTheDocument()
  })

  it("does not offer Email to client for an invoice the descriptor does not make it available for", () => {
    openMenu("draft")
    expect(screen.queryByTestId("document-email-client-button")).not.toBeInTheDocument()
  })
})
