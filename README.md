# agent-approvals

Ask before acting: approval gates for tool-using AI agents.

An agent that can send email, delete files or pay should read freely but wait for a person's **yes** before anything it can't take back. This library is that gate:

- **Ask:** a send, delete or payment becomes a pending action (an approval card) instead of running.
- **Run once:** approving claims the action atomically, so a double tap or a second device can't run it twice.
- **Run what was shown:** the arguments are hashed when the card is made and checked before running.
- **Expire:** cards that wait too long can no longer be approved (24 hours by default).
- **Undo:** a reversible write (a tool with an `undo`) can run at once with an Undo window instead of a card.
- **Outside content:** web pages, emails and app data reach the model inside per-result `<untrusted>` markers. Once a turn has read any, even reversible writes go back to asking.

Zero runtime dependencies. TypeScript, Web Crypto, works on Cloudflare Workers and Node 22.18+. Stores: in memory, or D1/SQLite.

## Usage

```ts
import { MemoryStore, createGate } from "agent-approvals"

const gate = createGate({
  store: new MemoryStore(), // or new SqlStore(env.DB) on Cloudflare D1
  tools: {
    send_email: { risk: "send", run: (args) => mail.send(args) },
    create_event: {
      risk: "write",
      run: (args) => calendar.create(args),
      undo: (_args, result) => calendar.delete(result.eventId),
    },
  },
})

// In the agent loop, for one person's turn:
const turn = gate.turn(userId)
const outcome = await turn.call({
  tool: "send_email",
  title: "Send an email to sam@example.com",
  risk: "send",
  args: { to: "sam@example.com", subject: "Lunch", body: "Friday at 1?" },
})
// -> { status: "waiting", id, message }: give `message` to the model, show the card to the person

// When the person taps Yes (your UI, never the model):
await gate.approve(outcome.id, userId) // -> { status: "done", result }
```

Outside content goes through the turn so it's marked:

```ts
const page = turn.untrusted(await fetchPage(url), "web")
// <untrusted id="9f2c..." source="web"> ... </untrusted id="9f2c...">
```

Add `UNTRUSTED_RULES` to your system prompt once.

## Outcomes

`turn.call(card)` returns `waiting` (a card was made), `done` (a reversible write ran, with `undoUntil`), or `refused` (unknown tool, or a card whose risk doesn't match its tool).

`gate.approve(id, owner)` returns `done`, `failed`, `expired`, `already_decided`, `changed` (stored arguments no longer match the card) or `not_found` (wrong id or wrong owner). `gate.deny` and `gate.undo` work the same way.

## Storage

`MemoryStore` for tests. `SqlStore` takes a D1 binding (or anything with D1's `prepare().bind().run()/first()`); create its table with `PENDING_ACTIONS_SQL`. The claim is one conditional `UPDATE ... WHERE status = 'pending'`, so it's safe across requests. Write your own store by implementing `PendingStore`.

See [`examples/worker.ts`](examples/worker.ts) for a Worker with an `/approve` route.

## What it doesn't do

It doesn't decide which actions are risky: you set `risk` per tool. It doesn't render cards or authenticate people: pass the owner id from your own auth. And the `<untrusted>` marker lowers prompt-injection risk; it doesn't remove it. That's why approvals come only from your UI, never from the model.

## Tests

```bash
npm install
npm test        # both stores: run-once, concurrent approve, expiry, owner check, undo, outside content
npm run typecheck
```

## License

MIT
