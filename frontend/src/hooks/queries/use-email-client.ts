import { useApiMutation } from "@/hooks/use-api-query"

interface EmailClientVariables {
  typeId: string
  documentId: string
  /** Absent: the server emails the client's primary contact. */
  recipient?: string
}

interface EmailClientResult {
  message: string
  recipient: string
  shareLinkId: string
}

/**
 * "Email to client" — mails a numbered invoice (PDF attached, plus a fresh customer pay link) to its
 * client. Never changes the invoice, so no query is invalidated. A mail-server failure comes back as an
 * ApiError whose message is the server's own sentence (502), which the dialog shows as-is.
 */
export function useEmailClient() {
  return useApiMutation<EmailClientVariables, EmailClientResult>(
    "POST",
    (vars) => `/api/documents/${vars.documentId}/email-client?typeId=${encodeURIComponent(vars.typeId)}`,
  )
}
