// A sketch of agent-approvals in a Cloudflare Worker with D1. The model's tool call goes
// through the gate; the person's tap on "Yes" hits /approve. Made-up tools only.
import { SqlStore, createGate, type D1Like, type Tools } from "../src/index.ts"

type Env = { DB: D1Like }

const tools: Tools = {
  send_email: {
    risk: "send",
    run: async (args: { to: string; subject: string; body: string }) => {
      // call your mail API here
      return { queued: true, to: args.to }
    },
  },
  add_label: {
    risk: "write",
    run: async (args: { messageId: string; label: string }) => ({ ...args }),
    undo: async () => {
      // remove the label again
    },
  },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gate = createGate({ store: new SqlStore(env.DB), tools })
    const url = new URL(request.url)
    const owner = request.headers.get("x-user-id") ?? "" // use your real auth here

    if (url.pathname === "/approve" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string }
      return Response.json(await gate.approve(id, owner))
    }

    if (url.pathname === "/demo") {
      const turn = gate.turn(owner)
      // what the agent loop does when the model calls send_email:
      const outcome = await turn.call({
        tool: "send_email",
        title: "Send an email to sam@example.com",
        risk: "send",
        args: { to: "sam@example.com", subject: "Lunch", body: "Friday at 1?" },
      })
      return Response.json(outcome) // { status: "waiting", id, message }
    }

    return new Response("not found", { status: 404 })
  },
}
