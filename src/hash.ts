/** JSON with object keys sorted at every level, so equal arguments give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) out[key] = sortKeys(item)
    }
    return out
  }
  return value
}

/** SHA-256 (hex) of the arguments' canonical JSON. Web Crypto: works in Workers and Node. */
export async function argsHash(args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(args))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
