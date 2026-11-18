import { argsHash } from "./hash.ts"
import type { PendingStore } from "./store.ts"
import type { ActionCard, PendingAction, Tools } from "./types.ts"
import { untrusted, type Source } from "./untrusted.ts"

export type GateOptions = {
  store: PendingStore
  tools: Tools
  /** How long a card can wait for a yes. Default 24 hours. */
  ttlMs?: number
  /** How long the Undo button works after an auto-run. Default 24 hours. */
  undoMs?: number
  /** Run reversible writes (tools with `undo`) at once instead of asking. Default true. */
  autoReversible?: boolean
  now?: () => number
  newId?: () => string
}

/** What the model gets back from a gated call. */
export type CallOutcome =
  | { status: "waiting"; id: string; message: string }
  | { status: "done"; id: string; result: unknown; undoUntil?: number }
  | { status: "refused"; message: string }

export type DecideOutcome =
  | { status: "done"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "already_decided" }
  | { status: "not_found" }
  | { status: "changed" }

const HOUR = 3_600_000

export function createGate(options: GateOptions) {
  const { store, tools } = options
  const ttlMs = options.ttlMs ?? 24 * HOUR
  const undoMs = options.undoMs ?? 24 * HOUR
  const autoReversible = options.autoReversible ?? true
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())

  async function record(owner: string, card: ActionCard): Promise<PendingAction> {
    const at = now()
    const action: PendingAction = {
      ...card,
      id: newId(),
      owner,
      status: "pending",
      argsHash: await argsHash(card.args),
      createdAt: at,
      expiresAt: at + ttlMs,
    }
    await store.create(action)
    return action
  }

  async function runClaimed(action: PendingAction): Promise<DecideOutcome> {
    const tool = tools[action.tool]
    if (!tool) {
      await store.finish(action.id, "failed", "unknown tool")
      return { status: "failed", error: "unknown tool" }
    }
    try {
      const result = await tool.run(action.args)
      await store.finish(action.id, "done", result)
      return { status: "done", result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await store.finish(action.id, "failed", message)
      return { status: "failed", error: message }
    }
  }

  /**
   * One agent turn for one person. Mark outside content as the turn reads it: after that,
   * nothing runs without a card, not even a reversible write.
   */
  function turn(owner: string) {
    let sawOutside = false

    return {
      get sawOutside() {
        return sawOutside
      },

      /** Wrap outside content for the model, and remember the turn has read some. */
      untrusted(text: string, source: Source): string {
        sawOutside = true
        return untrusted(text, source)
      },

      markOutside() {
        sawOutside = true
      },

      /** Ask for a yes, or run a reversible write at once. Never runs a send/delete/pay. */
      async call(card: ActionCard): Promise<CallOutcome> {
        const tool = tools[card.tool]
        if (!tool) return { status: "refused", message: `No tool named ${card.tool}.` }
        if (tool.risk !== card.risk) {
          return { status: "refused", message: `${card.tool} is a ${tool.risk} action.` }
        }
        const action = await record(owner, card)
        const reversible = autoReversible && card.risk === "write" && Boolean(tool.undo)
        if (reversible && !sawOutside && (await store.claim(action.id, "approved", now()))) {
          const out = await runClaimed(action)
          if (out.status === "done") {
            return { status: "done", id: action.id, result: out.result, undoUntil: now() + undoMs }
          }
          return { status: "refused", message: out.status === "failed" ? out.error : out.status }
        }
        return {
          status: "waiting",
          id: action.id,
          message: `Waiting for the person's yes: ${card.title}. Don't ask again or retry.`,
        }
      },
    }
  }

  /**
   * The person said yes (from your UI, never from the model). Claims the action once,
   * checks its arguments weren't changed since the card was shown, then runs it.
   */
  async function approve(id: string, owner: string): Promise<DecideOutcome> {
    const action = await store.get(id)
    if (!action || action.owner !== owner) return { status: "not_found" }
    if (action.status !== "pending") return { status: "already_decided" }
    if (action.expiresAt <= now()) {
      await store.claim(id, "expired", now())
      return { status: "expired" }
    }
    if ((await argsHash(action.args)) !== action.argsHash) {
      await store.claim(id, "denied", now())
      return { status: "changed" }
    }
    if (!(await store.claim(id, "approved", now()))) return { status: "already_decided" }
    return runClaimed(action)
  }

  async function deny(id: string, owner: string): Promise<DecideOutcome> {
    const action = await store.get(id)
    if (!action || action.owner !== owner) return { status: "not_found" }
    return (await store.claim(id, "denied", now())) ? { status: "denied" } : { status: "already_decided" }
  }

  /** Take back an auto-run (or approved) reversible action inside its undo window. */
  async function undo(id: string, owner: string): Promise<{ ok: boolean; reason?: string }> {
    const action = await store.get(id)
    if (!action || action.owner !== owner) return { ok: false, reason: "not_found" }
    const tool = tools[action.tool]
    if (!tool?.undo) return { ok: false, reason: "not_undoable" }
    if (action.status !== "done") return { ok: false, reason: "not_done" }
    if (now() > action.createdAt + undoMs) return { ok: false, reason: "too_late" }
    // Claim first, so two taps on Undo can't take it back twice.
    if (!(await store.markUndone(id))) return { ok: false, reason: "not_done" }
    try {
      await tool.undo(action.args, action.result)
      return { ok: true }
    } catch (error) {
      await store.finish(id, "done", action.result)
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return { turn, approve, deny, undo }
}
