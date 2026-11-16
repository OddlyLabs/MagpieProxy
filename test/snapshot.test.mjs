import assert from "node:assert/strict"
import { test } from "node:test"
import { providersView, accountTotals, claimsToday } from "../lib/snapshot.mjs"
const providers = [{ id: "zcode", name: "ZCode", kind: "login", accounts: [{ id: "a@example.com", label: "a@example.com" }, { id: "new@example.com", label: "new@example.com" }], proxies: { "a@example.com": "socks5://127.0.0.1:17901" } }]
const bindings = { bindings: { zcode: { "a@example.com": { port: 17901, mode: "auto" } } } }
const cfg = { managedProviders: ["zcode"] }
test("failed latest probes do not resurrect a cached IP", () => {
  const state = { assignments: { 17901: { node: "A", ip: "198.51.100.1" } }, last_check: { ts: 100, ports: { 17901: { node: "A", ip: null } } } }
  const result = providersView({ providers, cfg, bindings, state, authenticatedEmails: ["a@example.com"] })
  assert.equal(result[0].accounts[0].ip, null)
  assert.equal(result[0].accounts[0].proxy, "socks5://127.0.0.1:17901")
  assert.equal(result[0].accounts[0].proxyMismatch, false)
  assert.deepEqual(accountTotals(result), { accounts: 2, accountsBound: 1, pending: 1 })
})
test("a previous node's failed probe cannot contaminate its replacement", () => {
  const state = { assignments: { 17901: { node: "B", ip: "198.51.100.2" } }, last_check: { ports: { 17901: { node: "A", ip: null, zcode: "405" } } } }
  const account = providersView({ providers, cfg, bindings, state })[0].accounts[0]
  assert.equal(account.ip, "198.51.100.2"); assert.equal(account.zcode, null)
})
test("today's claims use Beijing dates, count successes only and deduplicate entitlements", () => {
  const now = Date.parse("2026-11-14T00:30:00+08:00")
  const record = { email: "a@example.com", time: "2026-11-13T16:10:00Z", plan: "zcode-v3-start-plan-1114", status: "claimed" }
  const result = claimsToday([record, { ...record, plan: record.plan + "-1", status: "done" }, { ...record, plan: "failed", status: "failed" }, { ...record, plan: "yesterday", time: "2026-11-13T15:59:00Z" }, { ...record, email: "b@example.com" }], now)
  assert.equal(result.total, 2); assert.equal(result.byAccount.get("a@example.com"), 1)
})
test("pending totals ignore unmanaged bindings and include newly discovered accounts", () => {
  const result = providersView({ providers, cfg: { managedProviders: [] }, bindings, state: null })
  assert.deepEqual(accountTotals(result), { accounts: 0, accountsBound: 0, pending: 0 })
})
