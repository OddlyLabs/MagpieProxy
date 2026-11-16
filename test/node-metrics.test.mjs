import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordNodeTests, nodeInsights, nodeFingerprint, loadNodeTests } from "../lib/node-metrics.mjs"
import { inspectNodes, saveState, loadState } from "../lib/egress.mjs"
import { DEFAULT_CONFIG } from "../lib/store.mjs"

const proxies = ["A", "B"].map((name, i) => ({ name, type: "socks5", server: `192.0.2.${i + 1}`, port: 1080, username: "test-user", password: "test-secret" }))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "egress-node-tests-")), previous = process.env.ZCODE_EGRESS_DATA
  process.env.ZCODE_EGRESS_DATA = root
  t.after(() => { previous === undefined ? delete process.env.ZCODE_EGRESS_DATA : process.env.ZCODE_EGRESS_DATA = previous; rmSync(root, { force: true, recursive: true }) })
  return { root, cfg: { ...DEFAULT_CONFIG, baseDir: join(root, "egress") }, ctx: { log() {} } }
}
test("node measurements retain real durations, target, time and safe metadata", (t) => {
  const { root } = fixture(t)
  recordNodeTests(proxies, [{ node: "A", ip: "198.51.100.1", tls: .123, total: .456, code: "401", password: "never-copy-me" }, { node: "B", code: "000" }], { source: "selection", checkedAt: 123456 })
  const saved = loadNodeTests()
  assert.equal(saved.A.tlsMs, 123); assert.equal(saved.A.totalMs, 456); assert.equal(saved.A.checkedAt, 123456)
  assert.equal(saved.A.status, "reachable"); assert.equal(saved.B.tlsMs, null); assert.equal(saved.B.status, "failed")
  const disk = readFileSync(join(root, "magpie-zcode-egress", "node-tests.json"), "utf8")
  assert.equal(/test-secret|test-user|never-copy-me/.test(disk), false)
})
test("changed node definitions invalidate previous measurements and failures replace old successes", (t) => {
  fixture(t)
  recordNodeTests(proxies, [{ node: "A", tls: .1, total: .2, code: "401" }])
  const same = { name: "A", fingerprint: nodeFingerprint(proxies[0]) }
  assert.equal(nodeInsights([same])[0].test.tlsMs, 100)
  assert.equal(nodeInsights([{ ...same, fingerprint: nodeFingerprint({ ...proxies[0], server: "192.0.2.99" }) }])[0].test, null)
  recordNodeTests(proxies, [{ node: "A", code: "000" }])
  assert.equal(nodeInsights([same])[0].test.tlsMs, null)
  assert.equal(nodeFingerprint(proxies[0]), nodeFingerprint(Object.fromEntries(Object.entries(proxies[0]).reverse())))
})
test("manual testing uses only the requested probe ports and leaves production state unchanged", async (t) => {
  const { cfg, ctx } = fixture(t), calls = []
  const before = { assignments: { 17901: { node: "A", ip: "198.51.100.8" } }, spares: [{ node: "B" }] }
  saveState(cfg, before)
  const result = await inspectNodes(cfg, ctx, ["B", "B"], { io: {
    proxies: async () => proxies,
    prepare: async (_cfg, names, ports) => { assert.deepEqual(names, ["B"]); assert.deepEqual(ports, [18200]); calls.push("prepare") },
    measure: async (port, name) => { assert.equal(port, 18200); assert.equal(name, "B"); calls.push("measure"); return { ip: "198.51.100.2", tls: .12, total: .2, code: "401" } },
    reset: async () => { calls.push("reset") },
  } })
  assert.deepEqual(calls, ["prepare", "measure", "reset"])
  assert.deepEqual(loadState(cfg), before); assert.equal(result.tested, 1); assert.equal(result.reachable, 1)
  assert.equal(loadNodeTests().B.tlsMs, 120)
})
test("invalid batches fail before preparation and failed preparation still cleans up", async (t) => {
  const { cfg, ctx } = fixture(t)
  let cleanups = 0
  const io = { proxies: async () => proxies, prepare: async () => { throw new Error("probe unavailable") }, reset: async () => { cleanups++ } }
  await assert.rejects(inspectNodes(cfg, ctx, [], { io }), /1–20/)
  await assert.rejects(inspectNodes(cfg, ctx, Array(21).fill("A"), { io }), /1–20/)
  await assert.rejects(inspectNodes(cfg, ctx, ["gone"], { io }), /不存在/)
  assert.equal(cleanups, 0)
  await assert.rejects(inspectNodes(cfg, ctx, ["A"], { io }), /probe unavailable/)
  assert.equal(cleanups, 1)
})
