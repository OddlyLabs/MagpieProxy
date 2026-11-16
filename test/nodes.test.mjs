import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dataDir } from "../lib/store.mjs"
import { loadSources, parseSubscriptionUrls, refreshSubscriptions, removeSubscription, saveSubUrl,
  readNodes, listNodeNames, sourcesSummary, importPool, clearPool } from "../lib/nodes.mjs"

const A = "https://airport-a.example/sub?token=a"
const B = "https://airport-b.example/sub?token=b"
const C = "https://airport-c.example/sub?token=c"
const cfg = { subUrl: "" }
const node = (name, server = "192.0.2.1") => ({ name, type: "socks5", server, port: 1080 })
const response = (nodes) => new Response(JSON.stringify({ proxies: nodes }))
let root, previousData

beforeEach(() => {
  previousData = process.env.ZCODE_EGRESS_DATA
  root = mkdtempSync(join(tmpdir(), "egress-nodes-test-"))
  process.env.ZCODE_EGRESS_DATA = root
})
afterEach(() => {
  if (previousData === undefined) delete process.env.ZCODE_EGRESS_DATA
  else process.env.ZCODE_EGRESS_DATA = previousData
  rmSync(root, { recursive: true, force: true })
})

const writeSources = (value) => {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(join(dataDir(), "nodes.json"), JSON.stringify(value))
}
const fetchWith = (t, respond) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return respond(url) })
  return calls
}

test("旧单订阅迁移保留节点名、时间、错误和手动号池", async (t) => {
  const old = node("old-node")
  writeSources({ sub: { url: A, nodes: [old], fetchedAt: 123, error: "previous failure" }, pool: { nodes: [node("manual")], addedAt: 456 } })
  const migrated = loadSources(cfg).subscriptions[0]
  assert.equal(migrated.url, A)
  assert.equal(migrated.fetchedAt, 123)
  assert.equal(migrated.error, "previous failure")
  assert.equal(loadSources(cfg).subscriptions[0].id, migrated.id)
  fetchWith(t, () => response([node("new-node")]))
  await refreshSubscriptions(cfg, { url: B })
  const saved = loadSources(cfg)
  assert.equal(saved.subscriptions.length, 2)
  assert.deepEqual(saved.subscriptions[0].nodes, [old])
  assert.equal(saved.pool.addedAt, 456)
  assert.equal(saved.pool.nodes[0].name, "manual")
  const disk = JSON.parse(readFileSync(join(dataDir(), "nodes.json"), "utf8"))
  assert.equal(disk.sub, undefined)
  assert.equal(disk.subscriptions.length, 2)
})

test("多个链接批量追加并去重，允许少于 8 个节点的小订阅", async (t) => {
  const calls = fetchWith(t, (url) => response([node(url === A ? "a" : "b")]))
  const result = await refreshSubscriptions(cfg, { urls: [A, B, A] })
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.count, 2)
  assert.equal(calls.length, 2)
  await refreshSubscriptions(cfg, { url: A })
  assert.equal(loadSources(cfg).subscriptions.length, 2)
  assert.deepEqual((await readNodes(cfg)).map((n) => n.name), ["a", "b"])
})

test("链接按行解析与规范化，输入有错时不写入任何订阅", async (t) => {
  assert.deepEqual(parseSubscriptionUrls(`  ${A}\r\n\n${B}\n${A}  `), [A, B])
  assert.deepEqual(parseSubscriptionUrls(["HTTPS://AIRPORT-A.EXAMPLE:443/sub?token=a", A]), [A])
  for (const input of ["", [], [A, 7], "ftp://airport.example/sub", `${A}\ninvalid`, `${A} ${B}`]) {
    assert.throws(() => parseSubscriptionUrls(input))
  }
  const calls = fetchWith(t, () => response([node("a")]))
  await assert.rejects(refreshSubscriptions(cfg, { urls: [A, "not-a-link"] }), /第 2 行/)
  assert.deepEqual(loadSources(cfg).subscriptions, [])
  assert.deepEqual(calls, [])
})

test("不同机场同名节点都保留，别名在刷新、移除其它机场后仍稳定", async (t) => {
  fetchWith(t, (url) => response([node("HK-01", url === A ? "192.0.2.1" : "198.51.100.1")]))
  await refreshSubscriptions(cfg, { url: A })
  await refreshSubscriptions(cfg, { url: B })
  const [a, b] = loadSources(cfg).subscriptions
  const alias = b.nodes[0].name
  assert.equal(a.nodes[0].name, "HK-01")
  assert.notEqual(alias, "HK-01")
  assert.equal((await readNodes(cfg)).length, 2)
  await refreshSubscriptions(cfg)
  assert.equal(loadSources(cfg).subscriptions[1].nodes[0].name, alias)
  removeSubscription(cfg, a.id)
  await refreshSubscriptions(cfg, { subscriptionId: b.id })
  assert.equal(loadSources(cfg).subscriptions[0].nodes[0].name, alias)
  assert.equal(listNodeNames(cfg)[0].subscriptionId, b.id)
})

test("单个机场失败保留旧缓存，其它机场仍更新成功", async (t) => {
  let failing = false
  fetchWith(t, (url) => url === B && failing
    ? new Response("unavailable", { status: 503 })
    : response([node(url === A ? "a" : "b", failing ? "192.0.2.2" : "192.0.2.1")]))
  await refreshSubscriptions(cfg, { urls: [A, B] })
  const before = loadSources(cfg).subscriptions[1]
  failing = true
  const result = await refreshSubscriptions(cfg)
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 1)
  const [a, b] = loadSources(cfg).subscriptions
  assert.equal(a.nodes[0].server, "192.0.2.2")
  assert.deepEqual(b.nodes, before.nodes)
  assert.equal(b.fetchedAt, before.fetchedAt)
  assert.match(b.error, /503/)
  assert.equal((await sourcesSummary(cfg)).total, 2)
})

test("失败的新订阅保持可管理，空内容或无节点内容不会清掉旧节点", async (t) => {
  let body = JSON.stringify({ proxies: [node("a")] })
  fetchWith(t, () => new Response(body))
  await refreshSubscriptions(cfg, { url: A })
  const cached = loadSources(cfg).subscriptions[0].nodes
  for (const invalid of ["", "<html>login required</html>", "proxies: []", "proxies: nope", "proxies: ["]) {
    body = invalid
    assert.equal((await refreshSubscriptions(cfg)).failed, 1)
    assert.deepEqual(loadSources(cfg).subscriptions[0].nodes, cached)
  }
  const result = await refreshSubscriptions(cfg, { url: B })
  assert.equal(result.failed, 1)
  const summary = await sourcesSummary(cfg)
  assert.equal(summary.subscriptions.length, 2)
  assert.equal(summary.subscriptions[1].count, 0)
  assert.ok(summary.subscriptions[1].error)
})

test("逐条更新和修改地址只影响目标订阅，重复地址被拒绝", async (t) => {
  const calls = fetchWith(t, (url) => response([node(url === B ? "b" : "a")]))
  await refreshSubscriptions(cfg, { urls: [A, B] })
  const [a, b] = loadSources(cfg).subscriptions
  calls.length = 0
  await refreshSubscriptions(cfg, { subscriptionId: a.id })
  assert.deepEqual(calls, [A])
  await refreshSubscriptions(cfg, { subscriptionId: a.id, url: C })
  const after = loadSources(cfg).subscriptions
  assert.equal(after[0].id, a.id)
  assert.equal(after[0].url, C)
  assert.deepEqual(after[1], b)
  await assert.rejects(refreshSubscriptions(cfg, { subscriptionId: a.id, url: B }), /已存在/)
  await assert.rejects(refreshSubscriptions(cfg, { subscriptionId: "missing" }), /找不到/)
  await assert.rejects(refreshSubscriptions(cfg, { subscriptionId: a.id, urls: [A, B] }), /一个链接/)
  assert.equal(loadSources(cfg).subscriptions[0].url, C)
})

test("移除订阅保留其它来源，全部移除后不会被旧 subUrl 自动恢复", async (t) => {
  const calls = fetchWith(t, (url) => response([node(url === A ? "a" : "b")]))
  await refreshSubscriptions(cfg, { urls: [A, B] })
  importPool("socks5://192.0.2.2:1080#manual")
  const [a, b] = loadSources(cfg).subscriptions
  removeSubscription(cfg, a.id)
  assert.deepEqual(loadSources(cfg).subscriptions.map((s) => s.id), [b.id])
  assert.equal(loadSources(cfg).pool.nodes.length, 1)
  removeSubscription(cfg, b.id)
  clearPool()
  calls.length = 0
  assert.deepEqual(await readNodes({ subUrl: A }), [])
  assert.deepEqual(calls, [])
  assert.throws(() => removeSubscription(cfg, "missing"), /找不到/)
})

test("旧配置 subUrl 能接入，保存其它地址时追加并保持幂等", async (t) => {
  const legacyCfg = { subUrl: A }
  fetchWith(t, (url) => response([node(url === A ? "a" : "b")]))
  assert.equal((await readNodes(legacyCfg))[0].name, "a")
  saveSubUrl(B, legacyCfg)
  saveSubUrl(B, legacyCfg)
  assert.equal(loadSources(legacyCfg).subscriptions.length, 2)
  assert.equal((await readNodes(legacyCfg)).length, 2)
})

test("候选池、节点选择器、统计对同名手动号池使用同一去重规则", async (t) => {
  fetchWith(t, () => response([node("shared")]))
  await refreshSubscriptions(cfg, { url: A })
  importPool("socks5://198.51.100.1:1080#shared")
  assert.equal((await readNodes(cfg))[0].server, "198.51.100.1")
  assert.deepEqual(listNodeNames(cfg).map(({ name, src }) => ({ name, src })), [{ name: "shared", src: "pool" }])
  assert.match(listNodeNames(cfg)[0].fingerprint, /^[a-f0-9]{24}$/)
  const summary = await sourcesSummary(cfg)
  assert.equal(summary.total, 1)
  assert.equal(summary.sub.count, 1)
  assert.equal(summary.pool.count, 1)
})

test("拉取期间导入号池或其它订阅，不会被旧快照覆盖", async (t) => {
  let finish
  fetchWith(t, (url) => url === A ? new Promise((resolve) => { finish = resolve }) : response([node("b")]))
  const pending = refreshSubscriptions(cfg, { url: A })
  importPool("socks5://192.0.2.2:1080#manual")
  await refreshSubscriptions(cfg, { url: B })
  finish(response([node("a")]))
  await pending
  const sources = loadSources(cfg)
  assert.equal(sources.subscriptions.length, 2)
  assert.equal(sources.subscriptions[1].nodes[0].name, "b")
  assert.equal(sources.pool.nodes[0].name, "manual")
})

test("拉取期间移除订阅，迟到的响应不能将它恢复", async (t) => {
  let finish
  fetchWith(t, () => new Promise((resolve) => { finish = resolve }))
  const pending = refreshSubscriptions(cfg, { url: A })
  removeSubscription(cfg, loadSources(cfg).subscriptions[0].id)
  finish(response([node("a")]))
  const result = await pending
  assert.equal(result.failed, 1)
  assert.deepEqual(loadSources(cfg).subscriptions, [])
})

test("拉取期间更换地址，迟到的旧地址响应不能覆盖新节点", async (t) => {
  let finish
  fetchWith(t, (url) => url === A ? new Promise((resolve) => { finish = resolve }) : response([node("new")]))
  const pending = refreshSubscriptions(cfg, { url: A })
  const id = loadSources(cfg).subscriptions[0].id
  await refreshSubscriptions(cfg, { subscriptionId: id, url: B })
  finish(response([node("old")]))
  await pending
  const source = loadSources(cfg).subscriptions[0]
  assert.equal(source.url, B)
  assert.equal(source.nodes[0].name, "new")
})
