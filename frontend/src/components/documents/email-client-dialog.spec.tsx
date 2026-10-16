import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from "sonner"

vi.mock("@/hooks/queries", () => ({
  useClient: vi.fn(),
  useEmailClient: vi.fn(),
}))

import { useClient, useEmailClient } from "@/hooks/queries"
import { EmailClientDialog } from "./email-client-dialog"

function renderDialog(mutateAsync: ReturnType<typeof vi.fn>, onOpenChange = vi.fn()) {
  vi.mocked(useClient).mockReturnValue({ data: { contactEmail: "billing@client.test" } } as never)
  vi.mocked(useEmailClient).mockReturnValue({ mutateAsync, isPending: false } as never)
  render(
    <EmailClientDialog typeId="invoice" documentId="inv-1" clientId="c-1" open onOpenChange={onOpenChange} />,
  )
  return onOpenChange
}

describe("<EmailClientDialog>", () => {
  beforeEach(() => vi.clearAllMocks())

  it("prefills the recipient from the client's primary contact and labels the field", () => {
    renderDialog(vi.fn())
    const input = screen.getByRole("textbox", { name: /Send to/ }) as HTMLInputElement
    expect(input.value).toBe("billing@client.test")
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Email to client")
  })

  it("sends to the prefilled address, toasts the outcome and closes", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ recipient: "billing@client.test" })
    const onOpenChange = renderDialog(mutateAsync)

    fireEvent.click(screen.getByTestId("email-client-send-button"))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(mutateAsync).toHaveBeenCalledWith({
      typeId: "invoice",
      documentId: "inv-1",
      recipient: "billing@client.test",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("sends an edited recipient instead", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ recipient: "other@client.test" })
    renderDialog(mutateAsync)

    fireEvent.change(screen.getByTestId("email-client-recipient"), {
      target: { value: " other@client.test " },
    })
    fireEvent.click(screen.getByTestId("email-client-send-button"))

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
    expect(mutateAsync.mock.calls[0][0].recipient).toBe("other@client.test")
  })

  it("shows the server's error and stays open when the mailer fails", async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error("The email could not be sent: SES said no"))
    const onOpenChange = renderDialog(mutateAsync)

    fireEvent.click(screen.getByTestId("email-client-send-button"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The email could not be sent: SES said no"))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("cannot send with an empty recipient", () => {
    renderDialog(vi.fn())
    fireEvent.change(screen.getByTestId("email-client-recipient"), { target: { value: "" } })
    expect(screen.getByTestId("email-client-send-button")).toBeDisabled()
  })
})
