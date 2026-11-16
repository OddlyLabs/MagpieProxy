import { spawn } from "node:child_process"
import { createServer, request } from "node:http"
import { readFileSync, mkdirSync, openSync, closeSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { resolveDataDir, defaultMagpieDir } from "./platform.mjs"
import { GEN } from "./gen.mjs"
import { readJson } from "./files.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const validPort = (value) => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535
export async function inspectService(port) {
  if (!validPort(port)) return null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1200) })
    const status = await response.json()
    return response.ok && status.service === "magpie-zcode-egress" ? status : null
  } catch { return null }
}

export async function ensureService({ magpieDirectory, port, runtime = process.execPath } = {}) {
  const env = { ...process.env, ZCODE_EGRESS_MAGPIE_DIR: magpieDirectory || process.env.ZCODE_EGRESS_MAGPIE_DIR || defaultMagpieDir() }
  const directory = resolveDataDir({ env })
  const live = async () => {
    let info
    try { info = JSON.parse(readFileSync(join(directory, "sidecar.pid"), "utf8")) } catch { return null }
    const status = await inspectService(info.port)
    return status?.gen === GEN && status.pid === info.pid && status.dataDir === directory ? status : null
  }
  const existing = await live()
  if (existing) return existing
  const config = readJson(join(directory, "config.json"), {}) ?? {}
  const wanted = port ?? env.ZCODE_EGRESS_PORT ?? config.apiPort ?? 3468
  if (!validPort(wanted)) throw new Error("服务端口需为 1–65535 的整数")
  env.ZCODE_EGRESS_PORT = String(wanted)
  mkdirSync(directory, { recursive: true })
  const log = join(directory, "startup.log")
  try { if (statSync(log).size > 1024 * 1024) writeFileSync(log, "", { mode: 0o600 }) } catch {}
  const out = openSync(log, "a", 0o600)
  let child, error
  try {
    child = spawn(runtime, [join(root, "server.mjs")], { env, cwd: directory, detached: true, windowsHide: true, stdio: ["ignore", out, out] })
    child.on("error", (value) => { error = value })
    child.unref()
  } finally { closeSync(out) }
  for (let i = 0; i < 100; i++) {
    const status = await live()
    if (status) return status
    if (error) throw new Error(`后台启动失败：${error.message}`)
    if (child.exitCode !== null && child.exitCode !== undefined) break
    await delay(150)
  }
  throw new Error(`出口管家后台未就绪，请运行 Diagnose.cmd 或查看 ${log}`)
}

// CLI hosts get a temporary page-service port. Forward it to the one sidecar
// instead of starting another scheduler or changing the stable local API port.
const proxies = new Map()
export async function exposeService(port, target) {
  if (Number(port) === Number(target.port)) return
  if (!validPort(port)) throw new Error("无效的插件页面端口")
  if (proxies.has(port)) return proxies.get(port)
  const current = await inspectService(port)
  if (current?.pid === target.pid && current?.dataDir === target.dataDir) return
  const server = createServer((req, res) => {
    const upstream = request({ hostname: "127.0.0.1", port: target.port, path: req.url, method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"后台服务正在重新连接，请刷新"}') })
    req.on("aborted", () => upstream.destroy()); req.pipe(upstream)
  })
  const ready = new Promise((resolve, reject) => {
    server.once("error", (error) => { proxies.delete(port); reject(new Error(`页面端口 ${port} 不可用（${error.code}），请修改插件的 port 选项或使用 Open.cmd`)) })
    server.listen(Number(port), "127.0.0.1", () => { server.unref(); resolve() })
  })
  proxies.set(port, ready)
  return ready
}
