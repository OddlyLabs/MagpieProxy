import assert from "node:assert/strict"
import { test } from "node:test"
import "../page/model.js"
const { accountState, matchesAccount, proxyAddress, snapshotKey, regionOf, nodeTestState, sortNodes } = globalThis.EgressUI
const account = { id: "alice@example.com", alias: "工作账号", node: "JP-Tokyo-01", ip: "198.51.100.42", port: 17901, hasJwt: true }
test("account search combines provider, account, node and address tokens", () => {
  assert.ok(matchesAccount(account, { name: "ZCode" }, "zcode TOKYO"))
  assert.ok(matchesAccount(account, { name: "ZCode" }, "工作 198.51"))
  assert.equal(matchesAccount(account, {}, "missing"), false)
  assert.equal(matchesAccount(account, {}, "", "pending"), false)
})
test("public exit IPs never become local proxy addresses", () => {
  assert.equal(proxyAddress(account), "socks5://127.0.0.1:17901")
  assert.equal(proxyAddress({ ip: "198.51.100.42" }), "")
  assert.equal(proxyAddress({ port: 70000 }), "")
})
test("account states expose failed, blocked, expired, unbound and disabled states", () => {
  assert.equal(accountState(account).key, "healthy")
  for (const [patch, key] of [[{ port: null }, "pending"], [{ ip: null }, "offline"], [{ zcode: "405" }, "blocked"], [{ lapsed: true }, "login"], [{ on: false }, "disabled"], [{ proxyMismatch: true }, "unsynced"], [{ zcode: "000" }, "timeout"]]) assert.equal(accountState({ ...account, ...patch }).key, key)
})
test("heartbeat-only updates do not invalidate the account DOM", () => {
  const before = { updated: 1000, lastPageSeen: 500, providers: [], config: { claimHour: 19 } }
  const after = { ...before, updated: 2000, lastPageSeen: 2000, config: { ...before.config, lastRequest: "heartbeat", requestResults: [] } }
  assert.equal(snapshotKey(before), snapshotKey(after))
  assert.notEqual(snapshotKey(before), snapshotKey({ ...after, task: { action: "assign" } }))
})
test("region filtering recognizes Chinese names and flags as well as prefixes", () => {
  assert.equal(regionOf("香港 01"), "HK"); assert.equal(regionOf("🇯🇵 Tokyo"), "JP"); assert.equal(regionOf("US-Phoenix-02"), "US")
})
test("latency state distinguishes missing, failed, current and historical measurements", () => {
  const now = 10_000_000
  assert.equal(nodeTestState({}, now).label, "未测试")
  assert.equal(nodeTestState({ test: { checkedAt: now, status: "failed", tlsMs: null } }, now).latency, "未测得")
  assert.equal(nodeTestState({ test: { checkedAt: now, status: "reachable", tlsMs: 0 } }, now).latency, "0 ms")
  assert.equal(nodeTestState({ test: { checkedAt: now - 3_600_001, status: "reachable", tlsMs: 42 } }, now).label, "历史结果")
})
test("latency ordering puts current observations first and unmeasured nodes last", () => {
  const now = 10_000_000
  const nodes = [{ name: "unknown" }, { name: "old-fast", test: { checkedAt: now - 4_000_000, tlsMs: 5 } }, { name: "current", test: { checkedAt: now, tlsMs: 180 } }, { name: "failed", test: { checkedAt: now, tlsMs: null, status: "failed" } }]
  assert.deepEqual(sortNodes(nodes, { order: "latency", now }).map((node) => node.name).slice(0, 2), ["current", "old-fast"])
  assert.equal(sortNodes(nodes, { now, spares: new Set(["unknown"]) })[0].name, "unknown")
})
