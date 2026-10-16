import { Send } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fieldHelpId, FieldLabel } from "@/components/ui/field-help"
import { Input } from "@/components/ui/input"
import { useClient, useEmailClient } from "@/hooks/queries"

interface EmailClientDialogProps {
  typeId: string
  documentId: string
  /** The invoice's `data.client` id, to prefill the client's primary contact email. */
  clientId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}

const EMAIL_INPUT_ID = "email-client-recipient"

/**
 * Confirm dialog of the invoice's "Email to client" action: shows who the email goes to (the client's
 * primary contact, editable) and sends it. The server owns every rule (status, country policy, address
 * validation, the pay link, the PDF), so this only collects the address and reports the outcome; a
 * failure is shown verbatim and the dialog stays open so the address can be corrected and retried.
 */
export function EmailClientDialog({
  typeId,
  documentId,
  clientId,
  open,
  onOpenChange,
}: EmailClientDialogProps) {
  const { t } = useTranslation()
  const { data: client } = useClient(clientId)
  const emailClient = useEmailClient()
  // `null` until the user types: the field then follows the client's contact as it loads, and a typed
  // value is never overwritten by that late arrival.
  const [typed, setTyped] = useState<string | null>(null)
  const recipient = typed ?? client?.contactEmail ?? ""

  const handleSend = async () => {
    const trimmed = recipient.trim()
    try {
      const result = await emailClient.mutateAsync({
        typeId,
        documentId,
        ...(trimmed ? { recipient: trimmed } : {}),
      })
      toast.success(t("documents.emailClient.success", { recipient: result.recipient }))
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("documents.emailClient.error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-cy="email-client-dialog">
        <DialogHeader>
          <DialogTitle>{t("documents.emailClient.title")}</DialogTitle>
          <DialogDescription>{t("documents.emailClient.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <FieldLabel
            htmlFor={EMAIL_INPUT_ID}
            required
            description={t("documents.emailClient.recipientDescription")}
          >
            {t("documents.emailClient.recipientLabel")}
          </FieldLabel>
          <Input
            id={EMAIL_INPUT_ID}
            type="email"
            autoComplete="off"
            value={recipient}
            onChange={(event) => setTyped(event.target.value)}
            aria-describedby={fieldHelpId(EMAIL_INPUT_ID)}
            placeholder={t("documents.emailClient.recipientPlaceholder")}
            data-cy="email-client-recipient"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("documents.emailClient.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSend}
            loading={emailClient.isPending}
            disabled={recipient.trim() === ""}
            dataCy="email-client-send-button"
          >
            <Send className="me-2 h-4 w-4" aria-hidden="true" />
            {t("documents.emailClient.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
