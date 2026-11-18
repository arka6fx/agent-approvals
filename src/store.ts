import type { PendingAction, PendingStatus } from "./types.ts"

/**
 * Where pending actions live. `claim` must be atomic: it moves an action out of
 * "pending" only once, so a double tap (or two devices) can't run it twice.
 */
export interface PendingStore {
  create(action: PendingAction): Promise<void>
  get(id: string): Promise<PendingAction | null>
  /** Move a pending, unexpired action to `to`. False when it wasn't pending any more. */
  claim(id: string, to: "approved" | "denied" | "expired", now: number): Promise<boolean>
  finish(id: string, status: "done" | "failed", result: unknown): Promise<void>
  /** Move a done action to "undone", once. False when it wasn't "done". */
  markUndone(id: string): Promise<boolean>
}

/** In memory, for tests and single-process use. */
export class MemoryStore implements PendingStore {
  #rows = new Map<string, PendingAction>()

  async create(action: PendingAction) {
    this.#rows.set(action.id, structuredClone(action))
  }

  async get(id: string) {
    const row = this.#rows.get(id)
    return row ? structuredClone(row) : null
  }

  async claim(id: string, to: "approved" | "denied" | "expired", now: number) {
    const row = this.#rows.get(id)
    if (!row || row.status !== "pending") return false
    if (to !== "expired" && row.expiresAt <= now) return false
    row.status = to
    return true
  }

  async finish(id: string, status: "done" | "failed", result: unknown) {
    const row = this.#rows.get(id)
    if (row) Object.assign(row, { status, result })
  }

  async markUndone(id: string) {
    const row = this.#rows.get(id)
    if (!row || row.status !== "done") return false
    row.status = "undone"
    return true
  }
}

/** The part of Cloudflare D1's API this store uses (also met by small SQLite adapters). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>
      first<T = Record<string, unknown>>(): Promise<T | null>
    }
  }
}

/** The table SqlStore expects. Run it once as a migration. */
export const PENDING_ACTIONS_SQL = `CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  risk TEXT NOT NULL,
  args TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_actions_owner ON pending_actions (owner, status);`

type Row = {
  id: string
  owner: string
  tool: string
  title: string
  detail: string | null
  risk: PendingAction["risk"]
  args: string
  args_hash: string
  status: PendingStatus
  result: string | null
  created_at: number
  expires_at: number
}

/** On D1 (or any SQLite with the same small API). The claim is one conditional UPDATE. */
export class SqlStore implements PendingStore {
  private db: D1Like

  constructor(db: D1Like) {
    this.db = db
  }

  async create(a: PendingAction) {
    await this.db
      .prepare(
        `INSERT INTO pending_actions
         (id, owner, tool, title, detail, risk, args, args_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        a.id,
        a.owner,
        a.tool,
        a.title,
        a.detail ?? null,
        a.risk,
        JSON.stringify(a.args),
        a.argsHash,
        a.status,
        a.createdAt,
        a.expiresAt,
      )
      .run()
  }

  async get(id: string) {
    const row = await this.db.prepare("SELECT * FROM pending_actions WHERE id = ?").bind(id).first<Row>()
    if (!row) return null
    return {
      id: row.id,
      owner: row.owner,
      tool: row.tool,
      title: row.title,
      ...(row.detail == null ? {} : { detail: row.detail }),
      risk: row.risk,
      args: JSON.parse(row.args),
      argsHash: row.args_hash,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.result == null ? {} : { result: JSON.parse(row.result) }),
    }
  }

  async claim(id: string, to: "approved" | "denied" | "expired", now: number) {
    const alive = to === "expired" ? "" : " AND expires_at > ?"
    const values: unknown[] = to === "expired" ? [to, id] : [to, id, now]
    const out = await this.db
      .prepare(`UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending'${alive}`)
      .bind(...values)
      .run()
    return out.meta.changes === 1
  }

  async finish(id: string, status: "done" | "failed", result: unknown) {
    await this.db
      .prepare("UPDATE pending_actions SET status = ?, result = ? WHERE id = ?")
      .bind(status, JSON.stringify(result ?? null), id)
      .run()
  }

  async markUndone(id: string) {
    const out = await this.db
      .prepare("UPDATE pending_actions SET status = 'undone' WHERE id = ? AND status = 'done'")
      .bind(id)
      .run()
    return out.meta.changes === 1
  }
}
