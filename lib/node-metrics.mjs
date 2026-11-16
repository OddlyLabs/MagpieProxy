import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"
import { dataDir } from "./store.mjs"
import { writeJsonAtomic } from "./files.mjs"

export const NODE_TEST_TARGET = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
export const NODE_TEST_TTL = 60 * 60_000
const path = () => join(dataDir(), "node-tests.json")
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
export const nodeFingerprint = (node) => createHash("sha256").update(JSON.stringify(canonical(node))).digest("hex").slice(0, 24)
export const loadNodeTests = () => {
  try { return JSON.parse(readFileSync(path(), "utf8")).nodes || {} } catch { return {} }
}
const milliseconds = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null

// Store measurements, never proxy credentials or invented fallback latencies.
export function recordNodeTests(proxies, results, { source = "manual", checkedAt = Date.now() } = {}) {
  const definitions = new Map(proxies.map((node) => [node.name, node])), records = Object.assign(Object.create(null), loadNodeTests())
  for (const result of results) {
    const proxy = definitions.get(result.node)
    if (!proxy) continue
    const code = /^\d{3}$/.test(result.code || "") ? result.code : null
    const tlsMs = milliseconds(result.tls), totalMs = milliseconds(result.total)
    const ip = isIP(String(result.ip || "")) ? result.ip : null
    records[result.node] = {
      fingerprint: nodeFingerprint(proxy), checkedAt, source, target: NODE_TEST_TARGET,
      ip, code, tlsMs, totalMs,
      status: code === "405" ? "blocked" : code && code !== "000" ? "reachable" : tlsMs !== null ? "tls-only" : ip ? "ip-only" : "failed",
    }
  }
  const retained = Object.entries(records).filter(([name, record]) => definitions.has(name) && record.fingerprint === nodeFingerprint(definitions.get(name)))
    .sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, 5000)
  writeJsonAtomic(path(), { version: 1, nodes: Object.fromEntries(retained) })
  return Object.fromEntries(retained)
}

export function nodeInsights(nodes, records = loadNodeTests()) {
  return nodes.map((node) => {
    const record = records[node.name]
    return { ...node, test: record?.fingerprint === node.fingerprint ? record : null }
  })
}
