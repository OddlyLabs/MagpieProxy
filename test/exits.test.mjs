// 单 Key 多出口：配置生成、绑定模型、增减出口、回滚、体检与面板投影。
// 全程走临时目录，不碰真实 magpie 数据，也不连真实的 mihomo 控制端口。
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { check, loadState, saveState, setExits, unbindAccount, swapPort, reviveFront, syncAll } from "../lib/egress.mjs"
import { buildEgressConfig, validateEgressConfig, writeConfig, frontName, LB_STRATEGIES, LB_TEST_URL } from "../lib/mihomo.mjs"
import { loadBindings, saveBindings, bindingPorts, portOwners, exitPortsOf, isMultiExit, proxyPortOf, proxyUrlOf, frontsOf, MAX_EXITS } from "../lib/bindings.mjs"
import { DEFAULT_CONFIG, saveConfig } from "../lib/store.mjs"
import { providersView } from "../lib/snapshot.mjs"
import { listProviders } from "../lib/providers.mjs"
import { buildRoster } from "../lib/claims.mjs"
import "../page/model.js"

const { accountState, proxyAddress, matchesAccount, exitsOf } = globalThis.EgressUI
const KEY = "sk-demo-single-key-0123456789abcdef"
const KEY_ID = createHash("sha256").update(KEY).digest("hex").slice(0, 10)
const proxies = ["A", "B", "C", "D", "E", "F"].map((name, i) => ({ name, type: "socks5", server: `192.0.2.${i + 1}`, port: 1080 }))
const url = (port) => `socks5://127.0.0.1:${port}`

function fixture(t, { multi = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "egress-exits-")), magpie = join(root, "magpie")
  const env = { data: process.env.ZCODE_EGRESS_DATA, magpie: process.env.ZCODE_EGRESS_MAGPIE_DIR }
  process.env.ZCODE_EGRESS_DATA = root; process.env.ZCODE_EGRESS_MAGPIE_DIR = magpie
  t.after(() => { for (const [key, value] of [["ZCODE_EGRESS_DATA", env.data], ["ZCODE_EGRESS_MAGPIE_DIR", env.magpie]]) value === undefined ? delete process.env[key] : process.env[key] = value; rmSync(root, { recursive: true, force: true }) })
  mkdirSync(magpie, { recursive: true })
  const bind = multi ? { port: 17901, extra: [17903, 17904], front: 17905, strategy: "round-robin", mode: "auto" } : { port: 17901, mode: "auto" }
  writeFileSync(join(magpie, "providers.json"), JSON.stringify({ providers: [
    { id: "atlas", name: "Atlas", key: KEY, accountProxies: { [KEY_ID]: proxyUrlOf(bind) } },
    { id: "zcode", accountNames: { "a@example.com": "A" }, accountProxies: { "a@example.com": url(17902) } },
  ] }))
  writeFileSync(join(magpie, "logins.json"), JSON.stringify([{ user: "a@example.com", agent: "plugin:zcode" }]))
  const cfg = { ...DEFAULT_CONFIG, baseDir: join(root, "egress"), managedProviders: ["atlas", "zcode"], autoAssignNew: false, sparesCount: 1, subUrl: "" }
  saveConfig(cfg)
  saveBindings({ bindings: { atlas: { [KEY_ID]: bind }, zcode: { "a@example.com": { port: 17902 } } } })
  const assignments = { 17901: { node: "A", ip: "198.51.100.1" }, 17902: { node: "B", ip: "198.51.100.2" } }
  if (multi) Object.assign(assignments, { 17903: { node: "D", ip: "198.51.100.4" }, 17904: { node: "E", ip: "198.51.100.5" } })
  saveState(cfg, { assignments, spares: [{ node: "C", ip: "203.0.113.3" }], last_zcode_ts: 0, last_zcode: {}, withGroups: true })
  const calls = { pool: [], rebuild: [], probe: [] }
  const io = {
    ensureApi: async () => true, proxies: async () => proxies, pause: async () => {},
    pool: async (_cfg, _ctx, options) => { calls.pool.push(options); return [{ node: "D", ip: "198.51.100.4" }, { node: "E", ip: "198.51.100.5" }, { node: "F", ip: "198.51.100.6" }].slice(0, options.want) },
    rebuild: async (_cfg, state, _ctx, options) => { calls.rebuild.push({ state: structuredClone(state), options: structuredClone(options) }) },
    probe: async (port) => { calls.probe.push(port); return "198.51.100.4" },
  }
  const accountProxies = () => Object.fromEntries(JSON.parse(readFileSync(join(magpie, "providers.json"), "utf8")).providers.map((p) => [p.id, p.accountProxies]))
  return { cfg, ctx: { log() {} }, io, calls, magpie, accountProxies }
}

test("generated configs route a front listener through a load-balance group of exit groups", () => {
  const assignments = { 17901: { node: "A" }, 17902: { node: "B" }, 17903: { node: "D" } }
  const fronts = [{ port: 17905, members: [17901, 17903], strategy: "sticky-sessions" }]
  const config = buildEgressConfig({ proxies, assignments, spares: [{ node: "C" }], sparePortBase: 17931, controller: "127.0.0.1:29093", withGroups: true, fronts })
  assert.deepEqual(validateEgressConfig(config), [])
  const group = config["proxy-groups"].find((g) => g.name === frontName(17905))
  assert.deepEqual({ type: group.type, strategy: group.strategy, proxies: group.proxies, url: group.url }, { type: "load-balance", strategy: "sticky-sessions", proxies: ["eg-17901", "eg-17903"], url: LB_TEST_URL })
  assert.ok(group.interval > 0)
  assert.equal(config.listeners.find((l) => l.port === 17905).proxy, "lb-17905")
  // 出口端口照常各自监听：体检仍能逐个探测，领取仍能固定走主出口
  for (const port of [17901, 17902, 17903]) assert.equal(config.listeners.find((l) => l.port === port).proxy, `eg-${port}`)

  const legacy = buildEgressConfig({ proxies, assignments, spares: [], sparePortBase: 17931, controller: "127.0.0.1:29093", withGroups: false, fronts })
  assert.deepEqual(validateEgressConfig(legacy), [])
  assert.deepEqual(legacy["proxy-groups"].find((g) => g.name === "lb-17905").proxies, ["A", "D"])
})

test("fronts never shadow an exit port, drop unassigned members and always state a strategy", () => {
  const assignments = { 17901: { node: "A" }, 17902: { node: "B" } }
  const build = (fronts) => buildEgressConfig({ proxies, assignments, spares: [], sparePortBase: 17931, controller: "127.0.0.1:29093", withGroups: true, fronts })
  const config = build([{ port: 17902, members: [17901, 17902] }, { port: 17906, members: [17901, 17999], strategy: "nonsense" }, { port: 70000, members: [17901] }])
  assert.deepEqual(validateEgressConfig(config), [])
  assert.equal(config["proxy-groups"].some((g) => g.name === "lb-17902"), false)
  assert.equal(config.listeners.filter((l) => l.port === 17902).length, 1)
  const group = config["proxy-groups"].find((g) => g.name === "lb-17906")
  // 不写 strategy 时 mihomo 按一致性哈希分流（实测），所以这里必须显式落盘
  assert.deepEqual([group.proxies, group.strategy], [["eg-17901"], LB_STRATEGIES[0]])
  assert.equal(config["proxy-groups"].some((g) => g.name === "lb-70000"), false)
})

test("config validation rejects group loops, empty groups and unknown strategies before mihomo sees them", () => {
  const base = () => buildEgressConfig({ proxies, assignments: { 17901: { node: "A" }, 17903: { node: "D" } }, spares: [], sparePortBase: 17931, controller: "127.0.0.1:29093", withGroups: true, fronts: [{ port: 17905, members: [17901, 17903] }] })
  const loop = base(); loop["proxy-groups"].find((g) => g.name === "eg-17901").proxies.push("lb-17905")
  assert.match(validateEgressConfig(loop).join("\n"), /循环引用/)
  const empty = base(); empty["proxy-groups"].find((g) => g.name === "lb-17905").proxies = []
  assert.match(validateEgressConfig(empty).join("\n"), /没有成员/)
  const strategy = base(); strategy["proxy-groups"].find((g) => g.name === "lb-17905").strategy = "random"
  assert.match(validateEgressConfig(strategy).join("\n"), /分流策略无效/)
  const clash = base(); clash["proxy-groups"].push({ name: "A", type: "select", proxies: ["D"] })
  assert.match(validateEgressConfig(clash).join("\n"), /重名/)
  const dir = mkdtempSync(join(tmpdir(), "egress-exits-config-"))
  try { assert.throws(() => writeConfig(join(dir, "config.yaml"), loop), /循环引用/) } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("binding helpers treat the front as the magpie address and every exit as an owned port", () => {
  const single = { port: 17901 }, multi = { port: 17901, extra: [17903, 17903, 17901, "x", 17904], front: 17905, strategy: "round-robin" }
  assert.deepEqual(exitPortsOf(single), [17901]); assert.deepEqual(exitPortsOf(multi), [17901, 17903, 17904]); assert.deepEqual(exitPortsOf({}), [])
  assert.equal(isMultiExit(single), false); assert.equal(isMultiExit(multi), true)
  // 只剩一个出口、或没有入口端口的残缺记录都按单出口处理
  assert.equal(isMultiExit({ port: 17901, extra: [], front: 17905 }), false); assert.equal(isMultiExit({ port: 17901, extra: [17903] }), false)
  assert.equal(proxyPortOf(single), 17901); assert.equal(proxyPortOf(multi), 17905); assert.equal(proxyPortOf({}), null)
  assert.equal(proxyUrlOf(multi), url(17905)); assert.equal(proxyUrlOf({ port: 17901, extra: [17903] }), url(17901)); assert.equal(proxyUrlOf({}), null)
  const bindings = { bindings: { atlas: { key: multi }, zcode: { "a@example.com": { port: 17902 } } } }
  assert.deepEqual(frontsOf(bindings), [{ port: 17905, members: [17901, 17903, 17904], strategy: "round-robin", provider: "atlas", account: "key" }])
  assert.deepEqual([...bindingPorts(bindings)].sort(), [17901, 17902, 17903, 17904, 17905])
  const owners = portOwners(bindings)
  for (const port of [17901, 17903, 17904]) assert.equal(owners.get(port).account, "key")
  assert.equal(owners.has(17905), false)
  assert.ok(MAX_EXITS >= 2)
})

test("growing a key to three exits verifies the front before magpie is pointed at it", async (t) => {
  const { cfg, ctx, io, calls, accountProxies } = fixture(t)
  const result = await setExits(cfg, ctx, "atlas", KEY_ID, 3, { io })
  assert.equal(result.ok, true); assert.equal(result.changed, true); assert.equal(result.partial, false); assert.equal(result.added, 2)
  const bind = loadBindings().bindings.atlas[KEY_ID]
  assert.equal(bind.port, 17901); assert.equal(bind.extra.length, 2); assert.equal(bind.strategy, "round-robin")
  const ports = new Set([17901, 17902, ...bind.extra, bind.front, 17931])
  assert.equal(ports.size, 6, "exit, front and spare ports are all distinct")
  assert.equal(result.front, bind.front); assert.equal(result.proxy, url(bind.front))
  assert.deepEqual(result.exits.map((exit) => [exit.port, exit.node, exit.primary]), [[17901, "A", true], [bind.extra[0], "D", false], [bind.extra[1], "E", false]])
  // 新出口不与任何已占用的节点 / 出口 IP 重复
  assert.deepEqual([...calls.pool[0].excludeNodes].sort(), ["A", "B", "C"]); assert.equal(calls.pool[0].want, 2)
  assert.ok(calls.pool[0].excludeIps.has("198.51.100.2") && calls.pool[0].excludeIps.has("203.0.113.3"))
  // 重建时入口已在配置里；只有入口探通后才写 magpie
  assert.deepEqual(calls.rebuild[0].options.verifyPorts, bind.extra)
  assert.equal(calls.rebuild[0].options.bindings.bindings.atlas[KEY_ID].front, bind.front)
  assert.deepEqual(calls.probe, [bind.front])
  assert.deepEqual(accountProxies(), { atlas: { [KEY_ID]: url(bind.front) }, zcode: { "a@example.com": url(17902) } })
  const state = loadState(cfg)
  assert.equal(state.assignments[bind.extra[0]].node, "D"); assert.deepEqual(state.assignments[17902], { node: "B", ip: "198.51.100.2" })
  assert.equal(JSON.stringify(result).includes(KEY), false, "results never carry the key itself")
})

test("a short candidate pool yields a partial result instead of failing", async (t) => {
  const { cfg, ctx, io } = fixture(t)
  io.pool = async () => [{ node: "D", ip: "198.51.100.4" }]
  const result = await setExits(cfg, ctx, "atlas", KEY_ID, 4, { strategy: "consistent-hashing", io })
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.exits.length, 2); assert.equal(result.strategy, "consistent-hashing")
  assert.equal(loadBindings().bindings.atlas[KEY_ID].extra.length, 1)
})

test("an unreachable front or a failed rebuild rolls everything back", async (t) => {
  for (const failure of ["probe", "rebuild"]) {
    const { cfg, ctx, io, calls, accountProxies } = fixture(t)
    const before = { bindings: loadBindings(), state: loadState(cfg), proxies: accountProxies() }
    if (failure === "probe") io.probe = async () => null
    else { let first = true; const rebuild = io.rebuild; io.rebuild = async (...args) => { if (first) { first = false; throw new Error("reload refused") } return rebuild(...args) } }
    const result = await setExits(cfg, ctx, "atlas", KEY_ID, 3, { io })
    assert.equal(result.ok, false); assert.match(result.why, failure === "probe" ? /没有连通/ : /reload refused/)
    assert.deepEqual(loadBindings().bindings, before.bindings.bindings); assert.deepEqual(loadState(cfg), before.state); assert.deepEqual(accountProxies(), before.proxies)
    // 回滚用磁盘上的原绑定重建：配置里不再有入口，也不再有新增的出口
    const last = calls.rebuild.at(-1)
    assert.deepEqual(Object.keys(last.state.assignments), ["17901", "17902"]); assert.equal(frontsOf(last.options.bindings).length, 0)
  }
})

test("no candidates leaves the account on its single exit", async (t) => {
  const { cfg, ctx, io, calls, accountProxies } = fixture(t)
  io.pool = async () => []
  const result = await setExits(cfg, ctx, "atlas", KEY_ID, 2, { io })
  assert.equal(result.ok, false); assert.match(result.why, /没有可用的新出口/)
  assert.equal(calls.rebuild.length, 0); assert.equal(isMultiExit(loadBindings().bindings.atlas[KEY_ID]), false)
  assert.equal(accountProxies().atlas[KEY_ID], url(17901))
})

test("invalid requests are refused before anything is probed", async (t) => {
  const { cfg, ctx, io, calls } = fixture(t)
  for (const [account, count, options, why] of [[KEY_ID, 0, {}, /出口数量/], [KEY_ID, MAX_EXITS + 1, {}, /出口数量/], [KEY_ID, 1.5, {}, /出口数量/], [KEY_ID, 2, { strategy: "random" }, /分流策略/], ["missing", 2, {}, /还没有绑定出口/]]) {
    const result = await setExits(cfg, ctx, "atlas", account, count, { ...options, io })
    assert.equal(result.ok, false); assert.match(result.why, why)
  }
  assert.equal(calls.pool.length + calls.rebuild.length, 0)
})

test("changing only the strategy keeps exits and the front port", async (t) => {
  const { cfg, ctx, io, calls, accountProxies } = fixture(t, { multi: true })
  const same = await setExits(cfg, ctx, "atlas", KEY_ID, 3, { io })
  assert.equal(same.ok, true); assert.equal(same.changed, false); assert.equal(calls.rebuild.length, 0)
  const result = await setExits(cfg, ctx, "atlas", KEY_ID, 3, { strategy: "sticky-sessions", io })
  assert.equal(result.changed, true); assert.equal(result.front, 17905); assert.equal(calls.pool.length, 0)
  assert.deepEqual(loadBindings().bindings.atlas[KEY_ID].extra, [17903, 17904]); assert.equal(loadBindings().bindings.atlas[KEY_ID].strategy, "sticky-sessions")
  assert.equal(accountProxies().atlas[KEY_ID], url(17905))
})

test("shrinking releases the newest exits; back to one exit restores the plain exit address first", async (t) => {
  const { cfg, ctx, io, calls, accountProxies } = fixture(t, { multi: true })
  const two = await setExits(cfg, ctx, "atlas", KEY_ID, 2, { io })
  assert.equal(two.removed, 1); assert.deepEqual(two.exits.map((exit) => exit.port), [17901, 17903]); assert.equal(two.front, 17905)
  assert.equal(loadState(cfg).assignments[17904], undefined)
  let proxiesAtRebuild
  io.rebuild = async (_cfg, _state, _ctx, options) => { proxiesAtRebuild = accountProxies().atlas[KEY_ID]; calls.rebuild.push({ options }) }
  const one = await setExits(cfg, ctx, "atlas", KEY_ID, 1, { io })
  assert.equal(one.ok, true); assert.equal(one.front, null); assert.equal(one.proxy, url(17901)); assert.equal(one.strategy, null)
  // magpie 先指回主出口，入口 listener 才被摘掉
  assert.equal(proxiesAtRebuild, url(17901))
  assert.deepEqual(loadBindings().bindings.atlas[KEY_ID].extra, undefined); assert.equal(loadBindings().bindings.atlas[KEY_ID].front, undefined)
  assert.deepEqual(Object.keys(loadState(cfg).assignments), ["17901", "17902"])
})

test("unbinding a multi-exit key frees every exit and clears its magpie proxy", async (t) => {
  const { cfg, ctx, calls, accountProxies } = fixture(t, { multi: true })
  const result = await unbindAccount(cfg, ctx, "atlas", KEY_ID, { io: { ensureApi: async () => true, rebuild: async (_cfg, state) => { calls.rebuild.push(structuredClone(state)) } } })
  assert.equal(result.removed, true); assert.deepEqual(result.ports, [17901, 17903, 17904])
  assert.deepEqual(Object.keys(calls.rebuild[0].assignments), ["17902"])
  assert.deepEqual(Object.keys(loadState(cfg).assignments), ["17902"])
  assert.equal(loadBindings().bindings.atlas, undefined)
  assert.deepEqual(accountProxies(), { atlas: {}, zcode: { "a@example.com": url(17902) } })
})

test("health checks repair a dead member exit and keep the binding on its front", async (t) => {
  const { cfg, ctx, accountProxies } = fixture(t, { multi: true })
  let rebuilt
  // 探测顺序：主出口端口升序（17901 17902 17903 17904），然后是备用位
  const result = await check(cfg, ctx, { force: true, io: {
    ensureApi: async () => true,
    probe: async () => ["198.51.100.1", "198.51.100.2", null, "198.51.100.5", "203.0.113.3"],
    probeZcode: async () => ["401", "401", "000", "401", "401"],
    rebuild: async (_cfg, state) => { rebuilt = structuredClone(state) },
  } })
  assert.equal(result.ok, true)
  assert.equal(rebuilt.assignments[17903].node, "C", "the dead member takes the spare, like any other exit")
  const bind = loadBindings().bindings.atlas[KEY_ID]
  assert.deepEqual([bind.port, bind.extra, bind.front], [17901, [17903, 17904], 17905])
  assert.equal(accountProxies().atlas[KEY_ID], url(17905))
})

test("sync writes the front address and the panel shows every exit without exposing the key", (t) => {
  const { cfg, ctx, accountProxies } = fixture(t, { multi: true })
  writeFileSync(join(process.env.ZCODE_EGRESS_MAGPIE_DIR, "providers.json"), JSON.stringify({ providers: [{ id: "atlas", name: "Atlas", key: KEY, accountProxies: { [KEY_ID]: url(17901) } }, { id: "zcode", accountNames: { "a@example.com": "A" }, accountProxies: {} }] }))
  const state = loadState(cfg); state.last_check = { ts: 1, ports: { 17903: { node: "D", ip: null } } }
  let view = providersView({ cfg, providers: listProviders(), bindings: loadBindings(), state })[0].accounts[0]
  assert.equal(view.proxyMismatch, true, "magpie still points at the plain exit")
  assert.equal(syncAll(cfg, { log: ctx.log }).ok, true)
  assert.equal(accountProxies().atlas[KEY_ID], url(17905))
  view = providersView({ cfg, providers: listProviders(), bindings: loadBindings(), state })[0].accounts[0]
  assert.deepEqual([view.port, view.node, view.front, view.strategy, view.proxy, view.proxyMismatch], [17901, "A", 17905, "round-robin", url(17905), false])
  assert.deepEqual(view.exits.map((exit) => [exit.port, exit.node, exit.ip, exit.primary]), [[17901, "A", "198.51.100.1", true], [17903, "D", null, false], [17904, "E", "198.51.100.5", false]])
  assert.equal(JSON.stringify(view).includes(KEY), false)
  const plain = providersView({ cfg, providers: listProviders(), bindings: loadBindings(), state })[1].accounts[0]
  assert.deepEqual([plain.exits, plain.front, plain.strategy, plain.proxy], [[], null, null, url(17902)])
})

test("claims stay pinned to the primary exit of a multi-exit account", (t) => {
  fixture(t)
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.y`
  writeFileSync(join(process.env.ZCODE_EGRESS_MAGPIE_DIR, "plugin-auth.json"), JSON.stringify({ zcode: { accountId: "a@example.com", refresh: JSON.stringify({ jwt, device: "d" }) } }))
  writeFileSync(join(process.env.ZCODE_EGRESS_MAGPIE_DIR, "providers.json"), JSON.stringify({ providers: [{ id: "zcode", accountNames: { "a@example.com": "A" }, accountProxies: { "a@example.com": url(17907) } }] }))
  assert.deepEqual(buildRoster().map((a) => [a.email, a.proxy, a.port]), [["a@example.com", url(17907), 17907]], "single-exit accounts follow magpie's own setting")
  saveBindings({ bindings: { zcode: { "a@example.com": { port: 17902, extra: [17906], front: 17907, strategy: "round-robin" } } } })
  assert.deepEqual(buildRoster().map((a) => [a.email, a.proxy, a.port]), [["a@example.com", url(17902), 17902]])
})

test("an instant node swap on a member exit re-tests its front group", async (t) => {
  const { cfg, ctx } = fixture(t, { multi: true })
  const revived = [], selections = []
  const io = { select: async (_api, group, node) => { selections.push([group, node]); return true }, pause: async () => {}, probe: async () => "203.0.113.3", revive: async (port) => { revived.push(port) } }
  const result = await swapPort(cfg, ctx, 17903, "C", { io })
  assert.equal(result.ok, true); assert.deepEqual(selections, [["eg-17903", "C"], ["spare-17931", "D"]]); assert.deepEqual(revived, [17903])

  const paths = []
  const call = async (api, path) => { paths.push([api, path]); return { ok: true } }
  assert.equal(await reviveFront(17903, { call }), true)
  assert.equal(paths[0][1], `/group/lb-17905/delay?url=${encodeURIComponent(LB_TEST_URL)}&timeout=5000`)
  assert.equal(await reviveFront(17902, { call }), false, "single-exit ports have no front to test")
  assert.equal(await reviveFront(17903, { call: async () => { throw new Error("offline") } }), false)
  assert.equal(paths.length, 1)
})

test("panel model reports degraded fronts, copies the front address and searches every exit", () => {
  const exits = [{ port: 17901, node: "HK-01", ip: "198.51.100.1", primary: true }, { port: 17903, node: "JP-Tokyo-02", ip: "198.51.100.4", primary: false }]
  const account = { id: "k", label: "sk-demo…0001", port: 17901, node: "HK-01", ip: "198.51.100.1", exits, front: 17905, strategy: "round-robin" }
  assert.equal(accountState(account).key, "healthy"); assert.match(accountState(account).detail, /2 个出口/)
  assert.equal(proxyAddress(account), url(17905)); assert.equal(exitsOf(account).length, 2)
  assert.equal(proxyAddress({ port: 17901, exits: [], front: null }), url(17901)); assert.deepEqual(exitsOf({ exits: [exits[0]] }), [])
  const provider = { id: "atlas", name: "Atlas" }
  assert.equal(matchesAccount(account, provider, "tokyo"), true); assert.equal(matchesAccount(account, provider, "17905"), true); assert.equal(matchesAccount(account, provider, "osaka"), false)
  const degraded = { ...account, exits: [exits[0], { ...exits[1], ip: null }] }
  assert.deepEqual([accountState(degraded).key, accountState(degraded).tone], ["degraded", "warn"])
  // 主出口掉线但其它出口在线：入口仍可用，不报「出口异常」
  const primaryDown = { ...account, ip: null, exits: [{ ...exits[0], ip: null }, exits[1]] }
  assert.equal(accountState(primaryDown).key, "degraded")
  const allDown = { ...account, ip: null, exits: exits.map((exit) => ({ ...exit, ip: null })) }
  assert.equal(accountState(allDown).key, "offline")
})

test("a fresh install with nothing to check never starts or downloads the backend", async (t) => {
  const { cfg, ctx } = fixture(t)
  rmSync(join(cfg.baseDir, "state.json"), { force: true })
  let started = 0
  const result = await check(cfg, ctx, { io: { ensureApi: async () => { started++; return true } } })
  assert.deepEqual([result.ok, result.idle, started], [false, true, 0])
  // 有等待自动分配的账号时仍然会拉起后端
  saveBindings({ bindings: { atlas: {}, zcode: { "a@example.com": { port: 17902 } } } })
  await check({ ...cfg, autoAssignNew: true }, ctx, { io: { ensureApi: async () => { started++; throw new Error("stop here") } } }).catch(() => {})
  assert.equal(started, 1)
})
