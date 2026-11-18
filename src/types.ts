/** How much an action can change. Everything above "read" needs a yes, unless reversible. */
export type Risk = "write" | "send" | "delete" | "pay"

/** What the person sees on the approval card. */
export type ActionCard = {
  /** The tool's name, e.g. "send_email". */
  tool: string
  /** A short line: "Send an email to sam@example.com". */
  title: string
  /** Optional detail shown under the title (the email body, the event time...). */
  detail?: string
  risk: Risk
  /** The exact arguments the tool will run with once approved. */
  args: Record<string, unknown>
}

export type PendingStatus = "pending" | "approved" | "denied" | "done" | "failed" | "expired" | "undone"

export type PendingAction = ActionCard & {
  id: string
  /** Who the action belongs to: only they can approve it. */
  owner: string
  status: PendingStatus
  /** SHA-256 of the canonical JSON of `args`, fixed when the card is made. */
  argsHash: string
  createdAt: number
  expiresAt: number
  /** The tool's result (or error text) once it ran. */
  result?: unknown
}

/** A tool the gate can run. `undo` makes it eligible to run at once with an Undo button. */
export type Tool<A = Record<string, unknown>, R = unknown> = {
  risk: Risk
  run: (args: A) => Promise<R>
  /** Takes back what `run` did, given its args and result. Only for truly reversible actions. */
  undo?: (args: A, result: R) => Promise<void>
}

export type Tools = Record<string, Tool<any, any>>
