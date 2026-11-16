// Local sidecar: task scheduling, stable HTTP API and sandboxed-page snapshots.
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { mkdirSync, appendFileSync, readFileSync, existsSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { loadConfig, saveConfig, loadSnapshot, writeSnapshot, loadRecords, clearRecords, dataDir, resolveBaseDir } from "./lib/store.mjs"
import { loadState, syncAll } from "./lib/egress.mjs"
import { loadBindings, migrateBindings, bindingOf, exitPortsOf, isMultiExit, proxyUrlOf, MAX_EXITS } from "./lib/bindings.mjs"
import { listProviders, managedIds } from "./lib/providers.mjs"
import { authAccounts, magpieDir } from "./lib/accounts.mjs"
import { claimRound, inClaimWindow, nextWindowAt } from "./lib/claims.mjs"
import { importPool, clearPool, refreshSubscriptions, removeSubscription, saveSubUrl, sourcesSummary, listNodeNames } from "./lib/nodes.mjs"
import { appVersion, fetchLatestVersion, noteRemoteVersion, remoteVersionInfo } from "./lib/version.mjs"
import { PLUGIN_VERSION, GEN } from "./lib/gen.mjs"
import { writeFileAtomic, writeJsonAtomic } from "./lib/files.mjs"
import { applyConfigPatch } from "./lib/config.mjs"
import { HttpError, readJsonBody, sendJson, assertLocalRequest } from "./lib/http.mjs"
import { TaskRunner, rememberReceipt } from "./lib/tasks.mjs"
import { providersView, accountTotals, claimsToday } from "./lib/snapshot.mjs"
import { nodeInsights } from "./lib/node-metrics.mjs"
import { runProcess } from "./lib/process.mjs"
import { acquireLock } from "./lib/lock.mjs"
import { serveDashboard } from "./lib/dashboard.mjs"
import { chromePath, displayReady } from "./lib/captcha.mjs"
import { binPath, LB_STRATEGIES } from "./lib/mihomo.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const pageDir = process.env.ZCODE_EGRESS_PAGE_DIR || join(here, "page")
const preferredPort = Number(process.env.ZCODE_EGRESS_PORT || loadConfig().apiPort || 3468)
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) throw new Error("API 端口需为 1–65535 的整数")
let livePort = preferredPort
const pidFile = join(dataDir(), "sidecar.pid")
const startedAt = Date.now()
const SERVICE = "magpie-zcode-egress"
const uiToken = randomBytes(32).toString("hex")
let releaseSeat = null
const cfg0 = () => loadConfig()
export const slog = (message) => {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${message}`
  console.log(line)
  try { mkdirSync(dataDir(), { recursive: true }); appendFileSync(join(dataDir(), "sidecar.log"), line + "\n", { mode: 0o600 }) } catch {}
}

// Never signal an arbitrary PID from a stale pidfile. Identify the service over HTTP.
async function inspectSidecar(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1200) })
    const status = await response.json()
    return response.ok && (status.service === SERVICE || (status.snapshot?.version?.plugin && status.snapshot?.egress && status.port === port)) && (!status.dataDir || status.dataDir === dataDir()) ? status : null
  } catch { return null }
}
async function retireSidecar(port) {
  const status = await inspectSidecar(port)
  if (!status) return false
  if (status.running) throw new Error("旧 sidecar 仍在执行任务，本次升级等待任务结束后重试")
  const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST", headers: { "X-Zcode-Egress": "1" }, signal: AbortSignal.timeout(2000),
  })
  return response.ok
}
const listenOnce = (server, port) => new Promise((resolve, reject) => {
  const onError = (error) => { server.removeListener("error", onError); reject(error) }
  server.once("error", onError)
  server.listen(port, "127.0.0.1", () => { server.removeListener("error", onError); resolve() })
})
async function takeSeat(server) {
  let previous
  try { previous = JSON.parse(readFileSync(pidFile, "utf8")) } catch {}
  if (previous?.port && previous.pid !== process.pid) {
    const existing = await inspectSidecar(previous.port)
    if (existing && existing.pid === previous.pid && (existing.gen || previous.gen) === GEN) {
      slog("已有同版本 sidecar 在运行")
      process.exit(0)
    }
    if (existing && existing.pid === previous.pid) { await retireSidecar(previous.port); await delay(300) }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try { releaseSeat = acquireLock(join(dataDir(), "sidecar.lock")); break }
    catch (error) {
      if (error.code !== "EGRESS_BUSY") throw error
      await delay(150)
      let current
      try { current = JSON.parse(readFileSync(pidFile, "utf8")) } catch {}
      if (current?.gen === GEN && (await inspectSidecar(current.port))?.pid === current.pid) process.exit(0)
    }
  }
  if (!releaseSeat) throw new Error("后台正在启动或退出，请稍后再试")
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = preferredPort + Math.max(0, attempt - 2)
    if (port > 65535) break
    try {
      await listenOnce(server, port)
      livePort = port
      writeJsonAtomic(pidFile, { pid: process.pid, port, gen: GEN, at: startedAt })
      return
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error
      const existing = await inspectSidecar(port)
      if (existing?.gen === GEN) process.exit(0)
      if (existing) await retireSidecar(port)
      await delay(500)
    }
  }
  throw new Error("API 端口已占用，无法启动 sidecar")
}

let lastCheckAt = 0, lastCheckResult = null, lastClaimAt = 0, lastClaimResult = null, lastPageSeen = 0
let lastSnapshot = 0, lastCheckTick = 0, lastClaimTick = 0
const panelActive = () => Date.now() - lastPageSeen < 12 * 60_000
const tasks = new TaskRunner(() => { void feedPage() })
const noteRequestId = (patch, result) => {
  if (!patch?.id) return
  saveConfig(rememberReceipt(cfg0(), patch.id, result))
}

// Serialize snapshot writes: a slower, older projection cannot overwrite a newer one.
let feedChain = Promise.resolve()
function feedPage() {
  feedChain = feedChain.catch(() => {}).then(async () => {
    try {
      const cfg = cfg0(), state = loadState(cfg), bindings = loadBindings(), records = loadRecords()
      let rawProviders = [], authenticatedEmails = [], providerError = ""
      try { rawProviders = listProviders() } catch (error) { providerError = String(error.message) }
      try { authenticatedEmails = authAccounts().map((a) => a.email) } catch {}
      const providers = providersView({ providers: rawProviders, cfg, bindings, state, records, authenticatedEmails })
      let sources
      try { sources = await sourcesSummary(cfg) }
      catch (error) { sources = { subscriptions: [], sub: {}, pool: {}, total: 0, error: String(error.message) } }
      const { poolText, ...publicConfig } = cfg
      const snapshot = {
        updated: Date.now(), port: livePort,
        config: { ...publicConfig, poolText: "" },
        version: { plugin: PLUGIN_VERSION, app: appVersion(), remote: remoteVersionInfo() },
        runtime: { platform: process.platform, arch: process.arch, magpieDir: magpieDir(), dataDir: dataDir(), baseDir: resolveBaseDir(cfg), browser: !!chromePath(), displayReady: displayReady(), coreInstalled: existsSync(binPath(resolveBaseDir(cfg))), url: `http://127.0.0.1:${livePort}/` },
        task: tasks.active ? { ...tasks.active } : null,
        egress: {
          hasState: !!state, withGroups: !!state?.withGroups, created: state?.created ?? null,
          lastCheck: state?.last_check?.ts ? state.last_check.ts * 1000 : null,
          lastZcode: state?.last_zcode_ts ? state.last_zcode_ts * 1000 : null,
          lastReseed: state?.last_reseed ? state.last_reseed * 1000 : null,
          error: state?.last_check?.error ?? "",
          assignments: state?.assignments ?? {},
          spares: (state?.spares ?? []).map((spare, i) => ({ port: Number(cfg.spareBase) + i, node: spare.node, ip: spare.ip })),
        },
        claims: {
          enabled: !!cfg.claimEnabled, inWindow: inClaimWindow(cfg), nextWindowAt: nextWindowAt(cfg),
          today: claimsToday(records).total, lastRunAt: lastClaimAt || null, lastResult: lastClaimResult,
        },
        sources, nodes: nodeInsights(listNodeNames(cfg)),
        onboard: {
          legacyDir: process.platform === "linux" && resolveBaseDir(cfg) === "/opt/zcode-egress" && existsSync("/opt/zcode-egress/docker-compose.yml") ? "/opt/zcode-egress" : null,
          hasState: !!state, stateWithGroups: !!state?.withGroups,
          ...accountTotals(providers), managed: providers.filter((p) => p.managed).map((p) => p.id),
          baseDir: resolveBaseDir(cfg), error: providerError,
        },
        check: { lastAt: lastCheckAt || null, lastResult: lastCheckResult, intervalMin: cfg.checkIntervalMin },
        providers, records: records.slice(-100).reverse(), lastPageSeen,
      }
      writeSnapshot(snapshot)
      lastSnapshot = Date.now()
      // Compatibility for the optional Settings panel and old sandbox pages.
      // A read-only package must never prevent the service UI from updating.
      try { writeFileAtomic(join(pageDir, "data.js"), `window.__ZE__ = ${JSON.stringify({ port: livePort, updated: snapshot.updated, snapshot })};\n`, { mode: 0o600 }) } catch {}
      return snapshot
    } catch (error) { slog("feedPage: " + String(error.message)); return null }
  })
  return feedChain
}

// flock also protects against the legacy cron job. Bound captured output and kill
// the entire process group on timeout so an orphan cannot retain the lock.
const flockRun = (cfg, args, timeoutMs = 30 * 60_000) => {
  const legacy = process.platform === "linux" && resolveBaseDir(cfg) === "/opt/zcode-egress"
  const command = legacy ? "flock" : process.execPath
  const argv = legacy ? ["-n", "-E", "75", cfg.cronLock || "/tmp/zcode-egress.lock", process.execPath] : []
  return runProcess(command, [...argv, join(here, "egress-cli.mjs"), ...args], { timeoutMs, env: { ...process.env, ZCODE_EGRESS_CONFIG: JSON.stringify(cfg) } })
}
const lockBusy = (result) => result.code === 75
const cliResult = (result, message) => ({
  ok: result.code === 0,
  kind: result.code === 0 ? "ok" : lockBusy(result) ? "warn" : "err",
  httpStatus: result.code === 0 ? 200 : lockBusy(result) ? 409 : 400,
  message: result.code === 0 ? message : lockBusy(result) ? "已有出口任务在执行，请稍后再试" : String(result.out).trim().replace(/^错误：/, "").slice(-220) || `任务失败（exit ${result.code}）`,
  code: result.code, out: result.out.slice(-4000),
})
const success = (message, extra = {}) => ({ ok: true, kind: "ok", message, ...extra })
const identity = (patch) => {
  const provider = typeof patch.provider === "string" ? patch.provider.trim() : ""
  const account = typeof patch.account === "string" ? patch.account.trim() : ""
  if (!provider || !account) throw new HttpError(400, "需要 provider 和 account")
  return { provider, account }
}

const actions = {
  async subscribe(patch) {
    const result = await refreshSubscriptions(cfg0(), patch)
    const message = result.failed ? `${result.succeeded} 个订阅更新成功，${result.failed} 个失败，请查看对应订阅的提示` : `已更新 ${result.succeeded} 个订阅，共 ${result.count} 个订阅节点`
    return { ...result, ok: result.succeeded > 0, kind: result.succeeded ? result.failed ? "warn" : "ok" : "err", message }
  },
  "subscription-remove"(patch) { removeSubscription(cfg0(), patch.subscriptionId); return success("已移除该订阅") },
  "pool-import"(patch) {
    const result = importPool(patch.text ?? "", { replace: patch.replace === true })
    return success(`号池已导入 ${result.added} 个节点，现有 ${result.total} 个`, result)
  },
  "pool-clear"() { clearPool(); return success("已清空号池") },
  async "probe-nodes"(patch) {
    if (!Array.isArray(patch.names) || !patch.names.length || patch.names.length > 20 || patch.names.some((name) => typeof name !== "string" || !name.trim() || name.length > 256 || /[\x00-\x1f]/.test(name))) throw new HttpError(400, "每次请选择 1–20 个有效节点")
    const names = [...new Set(patch.names)]
    const available = new Set(listNodeNames(cfg0()).map((node) => node.name))
    if (names.some((name) => !available.has(name))) throw new HttpError(400, "节点已移除或不存在，请刷新列表")
    const result = cliResult(await flockRun(cfg0(), ["probe-nodes", JSON.stringify(names)], 10 * 60_000), "节点测试完成")
    try {
      const detail = JSON.parse(result.out.trim().split("\n").at(-1))
      if (result.ok) { result.kind = detail.reachable === detail.tested ? "ok" : "warn"; result.message = `已测试 ${detail.tested} 个节点，${detail.reachable} 个目标可达，详情已更新` }
    } catch {}
    return result
  },
  async swap(patch) {
    const node = typeof patch.node === "string" ? patch.node.trim() : ""
    const port = Number(patch.port) || (patch.provider && patch.account ? bindingOf(loadBindings(), patch.provider, patch.account)?.port : 0)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !node) throw new HttpError(400, "需要节点名及有效端口，或 provider + account")
    return cliResult(await flockRun(cfg0(), ["swap", String(port), node], 10 * 60_000), `端口 ${port} 已换绑节点`)
  },
  async assign(patch) {
    const provider = typeof patch.provider === "string" ? patch.provider.trim() : ""
    const result = cliResult(await flockRun(cfg0(), ["assign", ...(provider ? [provider] : [])], 60 * 60_000), "分配完成，绑定已写入 magpie")
    try {
      const detail = JSON.parse(result.out.trim().split("\n").at(-1))
      if (detail.pending > 0 && result.ok) { result.kind = "warn"; result.message = `已分配 ${detail.assigned ?? 0} 个，仍有 ${detail.pending} 个待分配` }
    } catch {}
    return result
  },
  async bind(patch) {
    const { provider, account } = identity(patch)
    const node = typeof patch.node === "string" ? patch.node.trim() : ""
    return cliResult(await flockRun(cfg0(), ["bind", provider, account, ...(node ? ["--node", node] : [])]), "绑定已写入 magpie")
  },
  async unbind(patch) {
    const { provider, account } = identity(patch)
    return cliResult(await flockRun(cfg0(), ["unbind", provider, account]), "已解绑，出口端口已释放")
  },
  // 单 Key 多出口：count = 该账号的出口总数（1 = 改回单出口），strategy 可选。
  async exits(patch) {
    const { provider, account } = identity(patch)
    const count = Number(patch.count)
    if (!Number.isInteger(count) || count < 1 || count > MAX_EXITS) throw new HttpError(400, `出口数量需要是 1–${MAX_EXITS} 的整数`)
    if (patch.strategy !== undefined && !LB_STRATEGIES.includes(patch.strategy)) throw new HttpError(400, `分流策略只能是 ${LB_STRATEGIES.join(" / ")}`)
    const result = cliResult(await flockRun(cfg0(), ["exits", provider, account, String(count), ...(patch.strategy ? ["--strategy", patch.strategy] : [])], 60 * 60_000), count > 1 ? `已设为 ${count} 个出口` : "已改回单出口")
    try {
      const detail = JSON.parse(result.out.trim().split("\n").at(-1))
      if (result.ok) {
        const have = detail.exits?.length ?? count
        Object.assign(result, { exits: detail.exits ?? [], front: detail.front ?? null, strategy: detail.strategy ?? null, proxy: detail.proxy ?? null })
        if (detail.changed === false) result.message = `出口数量未变（${have} 个）`
        else if (detail.partial) { result.kind = "warn"; result.message = `可用节点不足，只凑到 ${have} 个出口（目标 ${count}）` }
        else if (have > 1) result.message = `已设为 ${have} 个出口，magpie 改走入口 :${detail.front}`
      } else if (detail.why) result.message = String(detail.why).slice(0, 220)
    } catch {}
    return result
  },
  config(patch) {
    const next = applyConfigPatch(cfg0(), patch)
    if (patch.__clearRecords !== undefined && typeof patch.__clearRecords !== "boolean") throw new HttpError(400, "__clearRecords 需要 true 或 false")
    if (typeof patch.subUrl === "string" && patch.subUrl.trim()) saveSubUrl(patch.subUrl, cfg0())
    if (patch.__clearRecords) clearRecords()
    saveConfig(next)
    const { poolText, ...publicConfig } = next
    return success(patch.__clearRecords ? "领取记录已清空" : "设置已保存", { config: publicConfig })
  },
  async check(patch) {
    const result = await flockRun(cfg0(), ["check", ...(patch.force === true ? ["--force"] : [])])
    lastCheckAt = Date.now()
    lastCheckTick = lastCheckAt
    lastCheckResult = { at: lastCheckAt, code: result.code, out: result.out.slice(-4000) }
    return cliResult(result, "出口体检完成")
  },
  async seed() {
    const result = await flockRun(cfg0(), ["seed"], 60 * 60_000)
    lastCheckAt = Date.now()
    lastCheckResult = { at: lastCheckAt, code: result.code, out: result.out.slice(-4000), seed: true }
    return cliResult(result, "出口重新分配完成")
  },
  async claims() {
    lastClaimAt = Date.now()
    lastClaimTick = lastClaimAt
    try {
      const result = await claimRound({ cfg: cfg0(), log: slog })
      const { claimed, done, failed, captcha, skipped } = result
      lastClaimResult = { at: Date.now(), claimed, done, failed, captcha, skipped }
      return success(`领取完成：成功 ${claimed}，已领过 ${done}，失败 ${failed}，验证码 ${captcha}，跳过 ${skipped}`, { ...lastClaimResult, kind: failed || captcha ? "warn" : "ok" })
    } catch (error) { lastClaimResult = { at: Date.now(), error: String(error.message) }; throw error }
  },
  async sync() { return cliResult(await flockRun(cfg0(), ["sync"]), "绑定已同步到 magpie") },
}

// The last 32 IDs survive heartbeats and restarts; retries within that window are idempotent.
const inflight = new Map()
async function executeAction(action, patch = {}) {
  if (patch.id) {
    const previous = cfg0().requestResults?.find((r) => r.id === patch.id)
    if (previous) {
      if (previous.action !== action) throw new HttpError(409, "请求 ID 已用于其它操作")
      return { ...previous, httpStatus: previous.httpStatus ?? (previous.ok ? 200 : 400), replayed: true }
    }
    if (inflight.has(patch.id)) {
      const pending = inflight.get(patch.id)
      if (pending.action !== action) throw new HttpError(409, "请求 ID 已用于其它操作")
      return pending.promise
    }
  }
  const promise = (async () => {
    let result
    try { result = await tasks.run(action, () => actions[action](patch), patch.id) }
    catch (error) { result = { ok: false, kind: error.statusCode === 409 ? "warn" : "err", message: String(error.message).slice(0, 220), httpStatus: error.statusCode || 400, ...(error.field ? { field: error.field } : {}) } }
    const httpStatus = result.httpStatus ?? (result.ok ? 200 : 400)
    noteRequestId(patch, { action, ok: result.ok, kind: result.kind, message: result.message, httpStatus })
    await feedPage()
    return { ...result, httpStatus }
  })()
  if (patch.id) inflight.set(patch.id, { action, promise })
  try { return await promise } finally { if (patch.id) inflight.delete(patch.id) }
}

const routes = new Map(Object.entries({
  "/api/subscribe": "subscribe", "/api/subscribe/remove": "subscription-remove",
  "/api/pool/import": "pool-import", "/api/pool/clear": "pool-clear",
  "/api/nodes/probe": "probe-nodes",
  "/api/swap": "swap", "/api/assign": "assign", "/api/bind": "bind", "/api/unbind": "unbind", "/api/exits": "exits",
  "/api/config": "config", "/api/check": "check", "/api/seed": "seed", "/api/claims/run": "claims", "/api/sync": "sync",
  "/api/v1/bind": "bind", "/api/v1/unbind": "unbind", "/api/v1/assign": "assign", "/api/v1/exits": "exits",
}))
const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS" && req.headers.origin === "null" && req.url?.startsWith("/api/")) {
      assertLocalRequest({ socket: req.socket, headers: { ...req.headers, origin: undefined } }, livePort)
      res.writeHead(204, { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type, X-Egress-Token", "Vary": "Origin" }); res.end(); return
    }
    assertLocalRequest(req, livePort, { uiToken })
    if (req.headers.origin === "null") { res.setHeader("Access-Control-Allow-Origin", "null"); res.setHeader("Vary", "Origin") }
    let url
    try { url = new URL(req.url, `http://127.0.0.1:${livePort}`) } catch { throw new HttpError(400, "无效的请求地址") }
    const path = url.pathname
    if (serveDashboard(req, res, path, uiToken)) return
    if (req.method === "GET" && path === "/api/status") return sendJson(res, 200, {
      ok: true, service: SERVICE, gen: GEN, pid: process.pid, startedAt, port: livePort, dataDir: dataDir(), magpieDir: magpieDir(),
      snapshot: loadSnapshot(), lastCheckAt, lastClaimAt, running: !!tasks.active, task: tasks.active,
    })
    if (path === "/api/ui-preferences" && ["GET", "POST"].includes(req.method)) {
      const file = join(dataDir(), "ui-preferences.json")
      let saved = {}
      try { saved = JSON.parse(readFileSync(file, "utf8")) } catch {}
      if (req.method === "POST") {
        const patch = await readJsonBody(req)
        if (patch.density !== undefined && !["comfortable", "compact", "grid"].includes(patch.density)) throw new HttpError(400, "无效的布局")
        if (patch.showProviders !== undefined && typeof patch.showProviders !== "boolean") throw new HttpError(400, "无效的供应商导航选项")
        for (const key of ["density", "showProviders"]) if (patch[key] !== undefined) saved[key] = patch[key]
        writeJsonAtomic(file, saved)
      }
      return sendJson(res, 200, { ok: true, pagePreferences: saved })
    }
    if (req.method === "GET" && path === "/api/nodes") return sendJson(res, 200, { ok: true, ...await sourcesSummary(cfg0()), nodes: nodeInsights(listNodeNames(cfg0())) })
    if (req.method === "GET" && path === "/api/v1/providers") {
      const cfg = cfg0(), providers = listProviders(), bindings = loadBindings(), state = loadState(cfg)
      return sendJson(res, 200, { ok: true, managed: managedIds(cfg, providers), providers: providersView({ providers, cfg, bindings, state }).map((p) => ({
        id: p.id, name: p.name, kind: p.kind, managed: p.managed,
        accounts: p.accounts.map((a) => ({ id: a.id, label: a.label, alias: a.alias, port: a.port, node: a.node, ip: a.ip, proxy: a.proxy, bound: !!a.port, exits: a.exits.map(({ port, node, ip, primary }) => ({ port, node, ip, primary })), front: a.front, strategy: a.strategy })),
      })) })
    }
    if (req.method === "GET" && path === "/api/v1/binding") {
      const { provider, account } = identity(Object.fromEntries(url.searchParams))
      const bind = bindingOf(loadBindings(), provider, account), state = loadState(cfg0())
      const assignment = state?.assignments?.[String(bind?.port)]
      // proxy 是 magpie 实际使用的地址：多出口时为分流入口，port / node / ip 仍是主出口。
      const multi = isMultiExit(bind)
      const exits = multi ? exitPortsOf(bind).map((port, i) => ({ port, node: state?.assignments?.[String(port)]?.node ?? null, ip: state?.assignments?.[String(port)]?.ip ?? null, primary: i === 0 })) : []
      return sendJson(res, 200, { ok: true, provider, account, port: bind?.port ?? null, node: assignment?.node ?? null, ip: assignment?.ip ?? null, proxy: proxyUrlOf(bind), mode: bind?.mode ?? null, exits, front: multi ? Number(bind.front) : null, strategy: multi ? bind.strategy ?? null : null })
    }
    if (req.method === "POST" && routes.has(path)) {
      const patch = await readJsonBody(req)
      lastPageSeen = Date.now()
      const { httpStatus, ...result } = await executeAction(routes.get(path), patch)
      return sendJson(res, httpStatus, { ...result, ...(!result.ok ? { error: result.message } : {}) })
    }
    if (req.method === "POST" && ["/api/page-target", "/api/page-seen"].includes(path)) {
      const patch = await readJsonBody(req)
      lastPageSeen = Date.now()
      noteRequestId(patch)
      await feedPage()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === "POST" && path === "/api/shutdown" && req.headers["x-zcode-egress"] === "1") {
      if (tasks.active) throw new HttpError(409, "任务仍在执行，请稍后重试")
      sendJson(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 150)
      return
    }
    const known = routes.has(path) || ["/api/status", "/api/nodes", "/api/v1/providers", "/api/v1/binding", "/api/page-target", "/api/page-seen"].includes(path)
    throw new HttpError(known ? 405 : 404, known ? "此接口不支持该请求方法" : "接口不存在")
  } catch (error) { sendJson(res, error.statusCode || 500, { ok: false, error: String(error.message) }) }
})
server.requestTimeout = 30_000
server.headersTimeout = 10_000

const tick = async () => {
  const cfg = cfg0(), now = Date.now()
  if (!tasks.active && now - lastCheckTick >= Math.max(2, Number(cfg.checkIntervalMin) || 10) * 60_000) {
    lastCheckTick = now
    void executeAction("check").catch((error) => slog(error.message))
  }
  if (!tasks.active && cfg.claimEnabled && inClaimWindow(cfg) && now - lastClaimTick >= Math.max(2, Number(cfg.claimIntervalMin) || 10) * 60_000) {
    lastClaimTick = now
    void executeAction("claims").catch((error) => slog(error.message))
  }
  if (now - lastSnapshot >= (panelActive() ? 5000 : 60_000)) await feedPage()
}
async function versionRefresh() {
  const cfg = cfg0()
  if (cfg.versionSource === "local") return
  try { const result = await fetchLatestVersion({ source: cfg.versionSource }); noteRemoteVersion(result) }
  catch (error) { noteRemoteVersion({ error: String(error.message).slice(0, 120) }) }
  await feedPage()
}
process.on("exit", () => {
  try { if (JSON.parse(readFileSync(pidFile, "utf8")).pid === process.pid) unlinkSync(pidFile) } catch {}
  releaseSeat?.()
})
process.once("SIGTERM", () => process.exit(0))
process.once("SIGINT", () => process.exit(0))
process.on("uncaughtException", (error) => { slog(`uncaughtException: ${error.stack || error}`); setTimeout(() => process.exit(1), 200) })
process.on("unhandledRejection", (error) => slog(`unhandledRejection: ${error?.stack || error}`))

takeSeat(server).then(async () => {
  slog(`sidecar on http://127.0.0.1:${livePort}`)
  try {
    const release = acquireLock(join(dataDir(), "egress.lock"))
    try { const cfg = cfg0(); migrateBindings(cfg, { log: slog }); syncAll(cfg0(), { log: slog }) } finally { release() }
  }
  catch (error) { slog("startup sync: " + String(error.message)) }
  lastCheckTick = lastClaimTick = Date.now()
  await feedPage()
  void versionRefresh()
  setInterval(() => { void tick().catch((error) => slog(error.message)) }, 5000)
}).catch((error) => { slog("sidecar 启动失败: " + String(error.message)); process.exit(1) })
