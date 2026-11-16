import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { check, loadState, saveState, seed } from "../lib/egress.mjs"
import { DEFAULT_CONFIG, saveConfig } from "../lib/store.mjs"
import { saveBindings } from "../lib/bindings.mjs"
import { providersView } from "../lib/snapshot.mjs"
import { listProviders } from "../lib/providers.mjs"
import { importPool } from "../lib/nodes.mjs"
import { loadNodeTests } from "../lib/node-metrics.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "egress-health-")), magpie = join(root, "magpie")
  const env = { data: process.env.ZCODE_EGRESS_DATA, magpie: process.env.ZCODE_EGRESS_MAGPIE_DIR }
  process.env.ZCODE_EGRESS_DATA = root; process.env.ZCODE_EGRESS_MAGPIE_DIR = magpie
  t.after(() => { for (const [key, value] of [["ZCODE_EGRESS_DATA", env.data], ["ZCODE_EGRESS_MAGPIE_DIR", env.magpie]]) value === undefined ? delete process.env[key] : process.env[key] = value; rmSync(root, { recursive: true, force: true }) })
  mkdirSync(magpie, { recursive: true })
  writeFileSync(join(magpie, "providers.json"), JSON.stringify({ providers: [{ id: "zcode", accountNames: { "a@example.com": "A", "b@example.com": "B" }, accountProxies: { "a@example.com": "socks5://127.0.0.1:17901", "b@example.com": "socks5://127.0.0.1:17902" } }] }))
  writeFileSync(join(magpie, "logins.json"), JSON.stringify(["a@example.com", "b@example.com"].map((user) => ({ user, agent: "plugin:zcode" }))))
  const cfg = { ...DEFAULT_CONFIG, baseDir: join(root, "egress"), managedProviders: ["zcode"], autoAssignNew: false, sparesCount: 2, subUrl: "" }
  saveConfig(cfg)
  const bindings = { bindings: { zcode: { "a@example.com": { port: 17901 }, "b@example.com": { port: 17902 } } } }
  saveBindings(bindings)
  saveState(cfg, { assignments: { 17901: { node: "A", ip: "198.51.100.1" }, 17902: { node: "B", ip: "198.51.100.2" } }, spares: [{ node: "C", ip: "203.0.113.3" }, { node: "D", ip: "203.0.113.4" }], last_zcode_ts: 0, last_zcode: {}, withGroups: true })
  return { cfg, bindings, ctx: { log() {} } }
}
test("all-outage protection records failure without moving any assignments", async (t) => {
  const { cfg, bindings, ctx } = fixture(t), before = loadState(cfg)
  const result = await check(cfg, ctx, { io: { ensureApi: async () => true, probe: async () => [null, null, null, null], rebuild: () => assert.fail("must not rebuild") } })
  assert.equal(result.ok, false)
  const state = loadState(cfg)
  assert.deepEqual(state.assignments, before.assignments)
  assert.equal(state.last_check.ports[17901].ip, null)
  assert.match(state.last_check.error, /无响应/)
  assert.equal(providersView({ cfg, providers: listProviders(), bindings, state })[0].accounts[0].ip, null)
})
test("new probe IPs reach state even when no rebuild is necessary", async (t) => {
  const { cfg, ctx } = fixture(t)
  const result = await check(cfg, ctx, { force: true, io: { ensureApi: async () => true, probe: async () => ["198.51.100.11", "198.51.100.12", "203.0.113.13", "203.0.113.14"], probeZcode: async () => ["401", "401", "401", "401"], rebuild: () => assert.fail("healthy exits need no rebuild") } })
  assert.equal(result.okCount, 2)
  const state = loadState(cfg)
  assert.equal(state.assignments[17901].ip, "198.51.100.11")
  assert.equal(state.spares[0].ip, "203.0.113.13")
})
test("failover excludes colliding spare IPs and rebuilds the updated spare pool", async (t) => {
  const { cfg, ctx } = fixture(t)
  let rebuilt
  await check(cfg, ctx, { force: true, io: {
    ensureApi: async () => true,
    probe: async () => [null, "198.51.100.20", "198.51.100.20", "203.0.113.40"],
    probeZcode: async () => ["405", "401", "401", "401"],
    rebuild: async (_cfg, state) => { rebuilt = structuredClone(state) },
  } })
  assert.equal(rebuilt.assignments[17901].node, "D")
  assert.deepEqual(rebuilt.spares, [])
  const state = loadState(cfg)
  assert.equal(state.last_check.ports[17901].zcode, "skip")
  assert.equal(state.last_zcode[17901], undefined)
})
test("reseed with no managed accounts fails before any backend work", async (t) => {
  const { cfg, ctx } = fixture(t)
  const result = await seed({ ...cfg, managedProviders: [] }, ctx)
  assert.equal(result.ok, false); assert.match(result.why, /没有受管账号/)
})
test("health checks retain real node timings without changing the public status codes", async (t) => {
  const { cfg, ctx } = fixture(t)
  importPool(JSON.stringify({ proxies: ["A", "B", "C", "D"].map((name, i) => ({ name, type: "socks5", server: `192.0.2.${i + 1}`, port: 1080 })) }))
  await check(cfg, ctx, { force: true, io: {
    ensureApi: async () => true,
    probe: async () => ["198.51.100.1", "198.51.100.2", "203.0.113.3", "203.0.113.4"],
    probeZcode: async () => Array.from({ length: 4 }, () => ({ code: "401", tls: .201, total: .378 })),
    rebuild: () => assert.fail("healthy exits need no rebuild"),
  } })
  assert.equal(loadNodeTests().A.tlsMs, 201); assert.equal(loadNodeTests().C.totalMs, 378)
  assert.equal(loadNodeTests().B.source, "health")
  assert.equal(loadState(cfg).last_check.ports[17901].zcode, "401")
})
