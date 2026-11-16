import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadState, saveState, swapPort } from "../lib/egress.mjs"
import { buildEgressConfig, validateEgressConfig, writeConfig } from "../lib/mihomo.mjs"
import { DEFAULT_CONFIG } from "../lib/store.mjs"

function fixture(t, withGroups = true) {
  const root = mkdtempSync(join(tmpdir(), "egress-swap-"))
  // 换绑会读 bindings.json（多出口入口），测试必须指向临时目录，不碰真实数据。
  const env = { data: process.env.ZCODE_EGRESS_DATA, magpie: process.env.ZCODE_EGRESS_MAGPIE_DIR }
  process.env.ZCODE_EGRESS_DATA = root; process.env.ZCODE_EGRESS_MAGPIE_DIR = join(root, "magpie")
  t.after(() => {
    for (const [key, value] of [["ZCODE_EGRESS_DATA", env.data], ["ZCODE_EGRESS_MAGPIE_DIR", env.magpie]]) value === undefined ? delete process.env[key] : process.env[key] = value
    rmSync(root, { recursive: true, force: true })
  })
  const cfg = { ...DEFAULT_CONFIG, baseDir: root }, ctx = { log() {} }
  const proxies = ["A", "B", "C", "D"].map((name, i) => ({ name, type: "socks5", server: `192.0.2.${i + 1}`, port: 1080 }))
  const state = { assignments: { 17901: { node: "A", ip: "198.51.100.1" }, 17902: { node: "B", ip: "198.51.100.2" } }, spares: [{ node: "C", ip: "198.51.100.3" }], withGroups, last_zcode: { 17901: { code: "405" }, 17902: { code: "401" } } }
  saveState(cfg, state)
  const path = join(root, "config", "config.yaml")
  writeConfig(path, buildEgressConfig({ proxies, assignments: state.assignments, spares: state.spares, sparePortBase: cfg.spareBase, controller: "127.0.0.1:19093", withGroups }))
  const io = { proxies: async () => proxies, select: () => assert.fail("unexpected selector mutation"), reload: () => assert.fail("unexpected config reload"), ready: async () => true, pause: async () => {}, probe: async () => "198.51.100.4" }
  return { cfg, ctx, state, path, io }
}

for (const withGroups of [true, false]) test(`unloaded candidates are installed without moving other accounts (${withGroups ? "selectors" : "legacy"})`, async (t) => {
  const { cfg, ctx, state, path, io } = fixture(t, withGroups)
  let reloads = 0
  io.reload = async () => {
    reloads++
    const config = JSON.parse(readFileSync(path, "utf8"))
    assert.deepEqual(validateEgressConfig(config), [])
    assert.deepEqual(config.proxies.map((p) => p.name), ["D", "B", "C"])
    if (withGroups) {
      assert.equal(config["proxy-groups"].find((g) => g.name === "eg-17901").proxies[0], "D")
      assert.equal(config["proxy-groups"].find((g) => g.name === "eg-17902").proxies[0], "B")
    } else assert.equal(config.listeners.find((l) => l.port === 17902).proxy, "B")
    return true
  }
  const result = await swapPort(cfg, ctx, 17901, "D", { io })
  assert.equal(result.ok, true); assert.equal(reloads, 1)
  const after = loadState(cfg)
  assert.equal(after.assignments[17901].node, "D"); assert.equal(after.assignments[17901].ip, "198.51.100.4")
  assert.deepEqual(after.assignments[17902], state.assignments[17902]); assert.deepEqual(after.spares, state.spares)
  assert.equal(after.last_zcode[17901], undefined); assert.deepEqual(after.last_zcode[17902], state.last_zcode[17902])
})

test("failed config loading restores the previous disk config and leaves bindings intact", async (t) => {
  const { cfg, ctx, state, path, io } = fixture(t)
  const before = readFileSync(path, "utf8")
  let reloads = 0
  io.reload = async () => ++reloads > 1
  io.probe = () => assert.fail("must not probe an unapplied binding")
  await assert.rejects(swapPort(cfg, ctx, 17901, "D", { io }), /配置加载失败/)
  assert.equal(reloads, 2); assert.equal(readFileSync(path, "utf8"), before)
  assert.deepEqual(loadState(cfg), state)
})

test("occupied and unknown nodes cannot change state or config", async (t) => {
  const { cfg, ctx, state, path, io } = fixture(t)
  const before = readFileSync(path, "utf8")
  await assert.rejects(swapPort(cfg, ctx, 17901, "B", { io }), /已绑定/)
  await assert.rejects(swapPort(cfg, ctx, 17901, "missing", { io }), /缺节点定义/)
  assert.deepEqual(loadState(cfg), state); assert.equal(readFileSync(path, "utf8"), before)
})

test("an already loaded spare swaps places through selectors without reloading", async (t) => {
  const { cfg, ctx, state, io } = fixture(t), selections = []
  io.select = async (_api, group, node) => { selections.push([group, node]); return true }
  const result = await swapPort(cfg, ctx, 17901, "C", { io })
  assert.equal(result.ok, true)
  assert.deepEqual(selections, [["eg-17901", "C"], ["spare-17931", "A"]])
  const after = loadState(cfg)
  assert.equal(after.assignments[17901].node, "C")
  assert.deepEqual(after.spares, [{ node: "A", ip: state.assignments[17901].ip }])
  assert.deepEqual(after.assignments[17902], state.assignments[17902])
})
