import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, request as httpRequest } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { acquireLock } from "../lib/lock.mjs"

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { const result = await fn(); if (result) return result } catch {} await delay(30) }
  throw new Error("Timed out waiting for isolated sidecar")
}
test("sidecar HTTP integration with isolated data, page and magpie directories", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "egress-api-")), magpie = join(root, "magpie"), data = join(root, "data", "magpie-zcode-egress")
  mkdirSync(magpie, { recursive: true }); mkdirSync(data, { recursive: true })
  const reservation = createServer(), port = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  const secret = "sk-integration-secret-that-must-not-be-exposed"
  writeFileSync(join(magpie, "providers.json"), JSON.stringify({ providers: [{ id: "atlas", name: "Atlas", key: secret }] }))
  writeFileSync(join(magpie, "logins.json"), "[]")
  writeFileSync(join(data, "config.json"), JSON.stringify({ apiPort: port, managedProviders: [], autoAssignNew: false, claimEnabled: false, checkIntervalMin: 180, versionSource: "local", baseDir: join(root, "egress"), cronLock: join(root, "cron.lock") }))
  const child = spawn(process.env.TEST_RUNTIME || process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    env: { ...process.env, ZCODE_EGRESS_PORT: String(port), ZCODE_EGRESS_DATA: join(root, "data"), ZCODE_EGRESS_MAGPIE_DIR: magpie, ZCODE_EGRESS_PAGE_DIR: join(root, "page") }, stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""; child.stdout.on("data", (d) => { logs = (logs + d).slice(-6000) }); child.stderr.on("data", (d) => { logs = (logs + d).slice(-6000) })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit } rmSync(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  const api = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  await until(async () => (await api("/api/status")).body.snapshot)

  await t.test("status identifies the service and publishes an atomic sandbox snapshot", async () => {
    const result = await api("/api/status")
    assert.equal(result.body.service, "magpie-zcode-egress"); assert.equal(result.body.running, false)
    assert.match(result.headers.get("cache-control"), /no-store/)
    assert.match(readFileSync(join(root, "page", "data.js"), "utf8"), /^window.__ZE__ = /)
  })
  await t.test("invalid JSON, array bodies and oversized payloads are rejected without mutations", async () => {
    assert.equal((await api("/api/config", "{bad")).status, 400)
    assert.equal((await api("/api/config", "[]")).status, 400)
    assert.equal((await api("/api/config", { mirror: "x".repeat(1_048_580) })).status, 413)
    assert.equal((await api("/api/config", { claimHour: 0, claimEnabled: "false" })).status, 400)
    assert.equal(JSON.parse(readFileSync(join(data, "config.json"))).claimHour, undefined)
  })
  await t.test("settings accept zero, and heartbeats cannot lose their receipt", async () => {
    assert.equal((await api("/api/config", { id: "save-midnight", claimHour: 0, claimMinute: 0 })).status, 200)
    await api("/api/page-seen", { id: "heartbeat-after-save" })
    const config = (await api("/api/status")).body.snapshot.config
    assert.equal(config.claimHour, 0); assert.equal(config.claimMinute, 0)
    assert.equal(config.lastRequest, "heartbeat-after-save")
    assert.equal(config.requestResults.find((r) => r.id === "save-midnight").ok, true)
  })
  await t.test("replaying a request ID cannot repeat or change an import", async () => {
    assert.equal((await api("/api/pool/import", { id: "pool-once", text: "socks5://127.0.0.1:1080#first" })).status, 200)
    const replay = await api("/api/pool/import", { id: "pool-once", text: "socks5://127.0.0.1:1081#second" })
    assert.equal(replay.body.replayed, true)
    assert.equal((await api("/api/nodes")).body.pool.count, 1)
    assert.equal((await api("/api/pool/clear", { id: "pool-once" })).status, 409)
  })
  await t.test("a long subscription update excludes competing mutations and exposes progress", async () => {
    let release
    const source = createServer((_req, res) => { release = () => { res.setHeader("Content-Type", "text/plain"); res.end('proxies:\n  - { name: integration-node, type: socks5, server: 127.0.0.1, port: 1080 }\n') } })
    const sourcePort = await listen(source)
    t.after(() => { source.closeAllConnections(); source.close() })
    const subscription = api("/api/subscribe", { id: "slow-sub", urls: [`http://127.0.0.1:${sourcePort}/sub`] })
    await until(() => release)
    assert.equal((await api("/api/status")).body.task.action, "subscribe")
    const rejected = await api("/api/config", { id: "competing-save", claimHour: 10 })
    assert.equal(rejected.status, 409); assert.equal(rejected.body.ok, false)
    release()
    assert.equal((await subscription).body.ok, true)
    const status = await api("/api/status")
    assert.equal(status.body.running, false)
    assert.equal(status.body.snapshot.config.claimHour, 0)
    assert.equal(status.body.snapshot.config.requestResults.find((r) => r.id === "competing-save").kind, "warn")
  })
  await t.test("provider API does not expose credentials and validates binding inputs", async () => {
    const result = await api("/api/v1/providers")
    assert.equal(result.body.providers[0].accounts.length, 1)
    assert.equal(JSON.stringify(result.body).includes(secret), false)
    assert.equal((await api("/api/v1/bind", { provider: "atlas" })).status, 400)
    assert.equal((await api("/api/v1/binding?provider=atlas")).status, 400)
    // 单 Key 多出口：未绑定的账号在两个只读接口里都是「没有入口、没有出口列表」
    assert.deepEqual([result.body.providers[0].accounts[0].exits, result.body.providers[0].accounts[0].front], [[], null])
    const binding = (await api(`/api/v1/binding?provider=atlas&account=${result.body.providers[0].accounts[0].id}`)).body
    assert.deepEqual([binding.exits, binding.front, binding.strategy, binding.proxy], [[], null, null, null])
    // 参数在进入任务队列之前校验，不会触发后台探测
    for (const patch of [{ provider: "atlas" }, { provider: "atlas", account: "k", count: 0 }, { provider: "atlas", account: "k", count: 9 }, { provider: "atlas", account: "k", count: "2.5" }, { provider: "atlas", account: "k", count: 2, strategy: "random" }]) {
      for (const path of ["/api/exits", "/api/v1/exits"]) assert.equal((await api(path, patch)).status, 400)
    }
    assert.equal((await api("/api/v1/exits")).status, 405)
    assert.equal((await api("/api/config")).status, 405)
  })
  await t.test("node insights expose safe metadata and reject invalid probe batches before execution", async () => {
    const result = await api("/api/nodes")
    const node = result.body.nodes.find((entry) => entry.name === "first")
    assert.equal(node.type, "socks5"); assert.equal(node.server, "127.0.0.1"); assert.equal(node.test, null)
    assert.equal(node.password, undefined); assert.equal(node.username, undefined)
    assert.equal((await api("/api/nodes/probe", { names: [] })).status, 400)
    assert.equal((await api("/api/nodes/probe", { names: Array(21).fill("first") })).status, 400)
    assert.equal((await api("/api/nodes/probe", { names: ["no-such-node"] })).status, 400)
    assert.equal((await api("/api/status")).body.running, false)
  })
  await t.test("cross-site origins and non-local hosts are rejected", async () => {
    assert.equal((await api("/api/config", {}, { Origin: "https://example.com" })).status, 403)
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(base + "/api/status", { headers: { Host: "rebind.example" } }, (res) => { res.resume(); resolve(res.statusCode) })
      request.on("error", reject); request.end()
    })
    assert.equal(response, 403)
  })
  await t.test("service dashboard works without writable package snapshots and authenticates sandbox calls", async () => {
    const response = await fetch(base + "/")
    assert.equal(response.status, 200)
    const html = await response.text(), token = html.match(/name="egress-session" content="([a-f0-9]{64})"/)?.[1]
    assert.ok(token)
    assert.equal((await api("/api/status", undefined, { Origin: "null" })).status, 403)
    const framed = await api("/api/status", undefined, { Origin: "null", "X-Egress-Token": token })
    assert.equal(framed.status, 200); assert.equal(framed.headers.get("access-control-allow-origin"), "null")
    const preferences = await api("/api/ui-preferences", { density: "grid", showProviders: false }, { Origin: "null", "X-Egress-Token": token })
    assert.equal(preferences.status, 200)
    assert.equal((await api("/api/ui-preferences")).body.pagePreferences.density, "grid")
    assert.equal((await api("/api/ui-preferences", { density: "unknown" })).status, 400)
    assert.equal((await fetch(base + "/_magpie/bridge.js")).status, 200)
    assert.equal((await fetch(base + "/package.json")).status, 404)
    assert.equal((await (await fetch(base + "/data.js")).text()).includes(secret), false)
  })
  await t.test("native task worker runs without flock and reports cross-process lock contention", async () => {
    assert.equal((await api("/api/sync", { id: "native-sync" })).status, 200)
    const release = acquireLock(join(data, "egress.lock"))
    try { assert.equal((await api("/api/sync", { id: "locked-sync" })).status, 409) } finally { release() }
  })
  await t.test("aborted requests cannot crash the service", async () => {
    const request = httpRequest(base + "/api/config", { method: "POST", headers: { "Content-Length": "10000" } })
    request.on("error", () => {})
    request.write('{"claimHour":')
    await delay(30); request.destroy(); await delay(300)
    assert.equal((await api("/api/status")).status, 200, logs)
    assert.equal(logs.includes("uncaughtException"), false, logs)
  })
})
