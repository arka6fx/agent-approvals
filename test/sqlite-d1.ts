// A tiny D1-shaped adapter over node:sqlite, so SqlStore is tested against real SQL.
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import type { D1Like } from "../src/store.ts"

export function sqliteD1(schema: string): D1Like {
  const db = new DatabaseSync(":memory:")
  db.exec(schema)
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      return {
        bind(...values: unknown[]) {
          const args = values as SQLInputValue[]
          return {
            async run() {
              const out = statement.run(...args)
              return { meta: { changes: Number(out.changes) } }
            },
            async first<T>() {
              return (statement.get(...args) as T | undefined) ?? null
            },
          }
        },
      }
    },
  }
}
