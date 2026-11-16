// mihomo 管理：docker（复用 zcode-egress / zcode-probe 容器）或独立内核（自动下载）。
// 配置用 JSON 写（JSON 是合法 YAML，mihomo 直接吃），节点解析用 vendored yaml。
import { spawn, execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs"
import { writeJsonAtomic, writeFileAtomic } from "./files.mjs"
import { join, dirname } from "node:path"
import { platform, arch } from "node:os"
import YAML from "../vendor/yaml/dist/index.js"
import { resolveBaseDir as resolveBaseDirLocal } from "./store.mjs"
import { executableName } from "./platform.mjs"
import { mihomoAsset, unpackMihomo, downloadBytes, verifyMihomo, MIHOMO_VERSION } from "./download.mjs"

export { YAML }

const sh = (args, timeout = 60_000) => new Promise((resolve) => {
  try {
    execFile(args[0], args.slice(1), { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ rc: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }))
  } catch (e) {
    resolve({ rc: 1, stdout: "", stderr: String(e) })
  }
})

const sudoDocker = async (args, timeout = 60_000) => {
  const result = await sh(["docker", ...args], timeout)
  if (result.rc === 0 || process.platform !== "linux") return result
  return sh(["sudo", "-n", "docker", ...args], timeout)
}

// —— 后端探测 ——

export async function detectBackend(baseDir) {
  if (process.platform !== "linux") return { dockerOk: false, composeExists: false }
  const dr = await sudoDocker(["info", "--format", "{{.ServerVersion}}"], 15_000)
  const dockerOk = dr.rc === 0 && dr.stdout.trim().length > 0
  const composeExists = existsSync(join(baseDir, "docker-compose.yml"))
  return { dockerOk, composeExists }
}

// —— 配置读写 ——

// 订阅（clash yaml 文本）→ 节点定义数组（过滤垃圾条目）
export function parseSubscription(text) {
  const doc = YAML.parse(text)
  const junk = /流量|到期|重置|官网|网站|订阅|Emby|剩余|套餐/
  const proxies = (Array.isArray(doc?.proxies) ? doc.proxies : []).filter((p) => p && p.name && p.type && !junk.test(String(p.name)))
  return proxies
}

export const fetchSubscription = async (subUrl, { timeoutMs = 90_000 } = {}) => {
  const res = await fetch(subUrl, {
    headers: { "User-Agent": "clash-verge/v2.4.2" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`订阅 HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim()) throw new Error("订阅内容为空")
  return text
}

// listener：socks5 监听。group 模式下 proxy 指向同名 selector 组，换节点不用 reload。
export const listener = (port, proxy, name) => ({
  name: name ?? `eg-${port}`,
  type: "socks",
  port: Number(port),
  listen: "127.0.0.1",
  proxy,
  udp: false,
})

// —— 单 Key 多出口：入口组 ——
//
// magpie 一个账号/Key 只能配一个代理地址，同一个 Key 也不能重复添加。多出口的做法是
// 让 magpie 指向一个本地「入口」端口，入口后面是 mihomo 的 load-balance 组，成员是
// 该账号各个出口端口自己的 eg-<port> 组。每个出口仍是普通出口：体检、故障换备用、
// IP 去重、单独换节点都照旧。以下行为在 mihomo v1.19.34 上实测：
//   round-robin        按「新连接」轮换，同一条 keep-alive 连接上的请求不换出口；
//   sticky-sessions    同一来源 + 目标粘住一个出口，约 10 分钟后重新挑选；
//   consistent-hashing 同一目标（按 eTLD+1）固定一个出口，成员失效才换。
// 不写 strategy 时 mihomo 用 consistent-hashing，所以这里总是显式写出。
// 成员连续失败后会被组健康检查判死、请求自动落到其余成员；恢复靠下一轮检查，
// 因此显式给出检查地址和较短间隔（lazy：入口没人用时不发检查请求）。
export const LB_STRATEGIES = ["round-robin", "sticky-sessions", "consistent-hashing"]
export const LB_TEST_URL = "https://www.gstatic.com/generate_204"
export const LB_TEST_INTERVAL = 30
export const frontName = (port) => `lb-${port}`
const frontGroup = (port, proxies, strategy) => ({
  name: frontName(port), type: "load-balance",
  strategy: LB_STRATEGIES.includes(strategy) ? strategy : LB_STRATEGIES[0],
  proxies, url: LB_TEST_URL, interval: LB_TEST_INTERVAL, lazy: true,
})

// 订阅里偶发同名节点（不同机场重名），写配置前统一去重（保留第一条）。
export const uniqProxies = (proxies) => {
  const seen = new Set()
  const out = []
  for (const p of proxies ?? []) {
    if (!p?.name || seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
  }
  return out
}

// 自检：mihomo 碰到「同名 proxy / 同名 group / 重复监听端口 / listener 指向不存在的组」
// 一律 fatal，容器会无限重启、所有 socks5 端口一起消失（2026-11-14 那次 502 事故）。
// 所以写盘前先查一遍：有问题直接抛错，旧配置留在盘上继续服务，不拿坏配置覆盖好配置。
export function validateEgressConfig(cfg) {
  const problems = []
  const nodeNames = new Set()
  for (const p of cfg?.proxies ?? []) {
    if (!p?.name) { problems.push("有节点定义缺 name"); continue }
    if (nodeNames.has(p.name)) problems.push(`节点名重复：${p.name}`)
    nodeNames.add(p.name)
  }
  // 策略组可以引用节点、内置出站或其它策略组（多出口入口组 lb-* 引用 eg-*），
  // 所以先收齐组名再查成员；节点与组共用一个命名空间，撞名同样 fatal。
  const groups = cfg?.["proxy-groups"] ?? []
  const groupNames = new Set()
  for (const g of groups) {
    if (!g?.name) { problems.push("有策略组缺 name"); continue }
    if (groupNames.has(g.name)) problems.push(`策略组名重复：${g.name}`)
    if (nodeNames.has(g.name)) problems.push(`策略组与节点重名：${g.name}`)
    groupNames.add(g.name)
  }
  const members = new Map()
  for (const g of groups) {
    if (!g?.name) continue
    if (!g.proxies?.length) problems.push(`策略组 ${g.name} 没有成员`)
    for (const n of g.proxies ?? []) {
      if (!nodeNames.has(n) && !groupNames.has(n) && !["DIRECT", "REJECT", "PASS"].includes(n)) problems.push(`策略组 ${g.name} 引用了不存在的节点：${n}`)
    }
    members.set(g.name, (g.proxies ?? []).filter((n) => groupNames.has(n)))
  }
  // 组之间成环 mihomo 会报 "loop is detected in ProxyGroup" 并拒载
  const visiting = new Set(), settled = new Set()
  const loops = (name) => {
    if (settled.has(name)) return false
    if (visiting.has(name)) return true
    visiting.add(name)
    const found = (members.get(name) ?? []).some(loops)
    visiting.delete(name); settled.add(name)
    return found
  }
  for (const name of members.keys()) if (loops(name)) { problems.push(`策略组循环引用：${name}`); break }
  for (const g of groups) {
    if (g?.type !== "load-balance") continue
    if (g.strategy !== undefined && !LB_STRATEGIES.includes(g.strategy)) problems.push(`策略组 ${g.name} 的分流策略无效：${g.strategy}`)
  }
  const usedPorts = new Set()
  for (const l of cfg?.listeners ?? []) {
    const port = Number(l?.port)
    if (usedPorts.has(port)) problems.push(`监听端口重复：${port}`)
    usedPorts.add(port)
    if (l?.proxy && !nodeNames.has(l.proxy) && !groupNames.has(l.proxy)) problems.push(`listener ${l?.name ?? port} 指向不存在的节点/组：${l.proxy}`)
  }
  return problems
}

// 写 mihomo 配置（JSON 形式的 YAML）。withGroups=true 时每个端口一个 selector 组，
// 组内是 assignments+spares 的全部节点（换节点走 API，不 reload）。
export function writeConfig(path, cfg) {
  const problems = validateEgressConfig(cfg)
  if (problems.length) {
    throw new Error(`mihomo 配置自检失败，拒绝写入（${problems.slice(0, 3).join("；")}${problems.length > 3 ? " …" : ""}）`)
  }
  writeJsonAtomic(path, cfg)
}

export function buildEgressConfig({ proxies, assignments, spares, sparePortBase, controller, withGroups = true, fronts = [] }) {
  const used = []
  for (const p of Object.values(assignments ?? {})) if (p?.node) used.push(p.node)
  for (const s of spares ?? []) if (s?.node) used.push(s.node)
  // 同一节点既当主出口又留在备用池时，used 里会出现两次 ⇒ 写出的 proxies 有两条同名，
  // mihomo 报 "proxy xxx is the duplicate name" 直接 fatal。这里按首次出现去重兜底
  // （状态层的冲突由 check 的备用池归一化、换绑/绑定的占用检查负责）。
  const uniqUsed = [...new Set(used)]
  const defs = new Map()
  for (const p of uniqProxies(proxies)) if (!defs.has(p.name)) defs.set(p.name, p)
  const missing = uniqUsed.filter((n) => !defs.has(n))
  if (missing.length) throw new Error(`配置里缺节点定义: ${missing.slice(0, 3).join(", ")}…`)
  const cfg = {
    "mixed-port": 0,
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    ipv6: false,
    "external-controller": controller,
    "unified-delay": true,
    "tcp-concurrent": true,
    profile: { "store-selected": false, "store-fake-ip": false },
    proxies: uniqUsed.map((n) => defs.get(n)),
    listeners: [],
    rules: ["MATCH,DIRECT"],
  }
  if (withGroups) {
    const names = uniqUsed
    cfg["proxy-groups"] = []
    for (const port of Object.keys(assignments ?? {}).sort((a, b) => a - b)) {
      const own = assignments[port]?.node
      // select 组重载后的默认选中是列表第一项：把本端口自己的节点钉在组首，
      // 否则 reload 后所有端口都会落到同一个节点上
      cfg["proxy-groups"].push({ name: `eg-${port}`, type: "select", proxies: [own, ...names.filter((n) => n !== own)] })
      cfg.listeners.push(listener(port, `eg-${port}`))
    }
    ;(spares ?? []).forEach((s, i) => {
      const port = Number(sparePortBase) + i
      cfg["proxy-groups"].push({ name: `spare-${port}`, type: "select", proxies: [s.node, ...names.filter((n) => n !== s.node)] })
      cfg.listeners.push(listener(port, `spare-${port}`, `spare-${port}`))
    })
  } else {
    for (const port of Object.keys(assignments ?? {}).sort((a, b) => a - b)) {
      cfg.listeners.push(listener(port, assignments[port].node))
    }
    ;(spares ?? []).forEach((s, i) => {
      cfg.listeners.push(listener(Number(sparePortBase) + i, s.node, `spare-${Number(sparePortBase) + i}`))
    })
  }
  // 多出口入口：fronts = [{ port, members: [出口端口…], strategy }]。
  // 成员只认当前确有分配记录的端口；入口端口与已有监听撞车时整项跳过——
  // 一条异常绑定不能让整份配置写不出去（其它账号的出口会跟着遭殃）。
  const listening = new Set(cfg.listeners.map((l) => l.port))
  for (const front of fronts ?? []) {
    const port = Number(front?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || listening.has(port)) continue
    const ports = [...new Set((front.members ?? []).map(String))].filter((p) => assignments?.[p]?.node)
    const targets = [...new Set(ports.map((p) => withGroups ? `eg-${p}` : assignments[p].node))]
    if (!targets.length) continue
    ;(cfg["proxy-groups"] ??= []).push(frontGroup(port, targets, front.strategy))
    cfg.listeners.push(listener(port, frontName(port), frontName(port)))
    listening.add(port)
  }
  return cfg
}

// —— 控制器 API ——

export const apiCall = async (api, path, { method = "GET", body, timeoutMs = 15_000 } = {}) => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => "")
  return { status: res.status, ok: res.ok, text }
}

export const waitApi = async (api, timeoutMs = 40_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await apiCall(api, "/version", { timeoutMs: 3000 })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

export const reloadConfig = async (api, container, configInContainer, { log = () => {}, baseDir } = {}) => {
  const binary = baseDir && activeBackend(baseDir) === "binary"
  const configPath = binary ? join(baseDir, container === "zcode-probe" ? "probe-config" : "config", "config.yaml") : configInContainer
  let r
  try { r = await apiCall(api, "/configs?force=true", { method: "PUT", body: { path: configPath }, timeoutMs: 40_000 }) }
  catch { return false }
  if (r.status === 200 || r.status === 204) {
    log(`${container} reload OK (${r.status})`)
    return true
  }
  if (binary) { log(`mihomo 拒绝配置（HTTP ${r.status}）：${r.text.slice(0, 120)}`); return false }
  log(`${container} reload HTTP ${r.status} ${r.text.slice(0, 120)}，回退重启`)
  const rr = await sudoDocker(["restart", container], 120_000)
  if (rr.rc !== 0) return false
  // 重启后必须真的起来：配置被 mihomo 拒载时容器会无限重启（"Restarting N seconds ago"），
  // 以前这里只返回 docker restart 的退出码，等于把「服务已经挂了」当「切换成功」。
  const up = await waitApi(api, 60_000)
  if (!up) log(`⚠ ${container} 重启后 API 仍不通（多半是配置被 mihomo 拒载，看 docker logs ${container}）`)
  return up
}

// 直接重启生产容器（配置刚写盘、API 还没起时用；不走 reload）。
export const restartEgressContainer = async (container = "zcode-egress") => {
  const rr = await sudoDocker(["restart", container], 120_000)
  if (rr.rc !== 0) return false
  return waitApi("http://127.0.0.1:19093", 60_000)
}

// selector 组换节点（{"name": ...} 是 clash 原生字段；新 mihomo 只认这个）
export const selectNode = async (api, group, node) => {
  const r = await apiCall(api, `/proxies/${encodeURIComponent(group)}`, { method: "PUT", body: { name: node } })
  return r.status === 204 || r.status === 200
}

export const groupInfo = async (api, group) => {
  const r = await apiCall(api, `/proxies/${encodeURIComponent(group)}`)
  if (!r.ok) return null
  try { return JSON.parse(r.text) } catch { return null }
}

// mihomo 自带的节点延迟测试（url 可换成 zcode 端点）
export const delayTest = async (api, node, url, timeoutMs = 8000) => {
  const r = await apiCall(api, `/proxies/${encodeURIComponent(node)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(url)}`, { timeoutMs: timeoutMs + 4000 })
  if (!r.ok) return null
  try { return JSON.parse(r.text)?.delay ?? null } catch { return null }
}

// —— docker 后端 ——

export async function ensureContainers(baseDir, names = ["zcode-egress", "zcode-probe"]) {
  const missing = []
  for (const n of names) {
    const r = await sudoDocker(["inspect", "-f", "{{.State.Running}}", n], 20_000)
    if (r.stdout.trim() !== "true") missing.push(n)
  }
  if (!missing.length) return true
  for (const n of missing) {
    const cfgDir = n === "zcode-egress" ? join(baseDir, "config") : join(baseDir, "probe-config")
    const ctl = n === "zcode-egress" ? "127.0.0.1:19093" : "127.0.0.1:19094"
    if (!existsSync(join(cfgDir, "config.yaml"))) {
      mkdirSync(cfgDir, { recursive: true })
      writeConfig(join(cfgDir, "config.yaml"), {
        "mixed-port": 0, "external-controller": ctl, proxies: [], listeners: [], rules: ["MATCH,DIRECT"],
      })
    }
  }
  // 自举：没有 compose 文件就生成一套（新机器上 baseDir 是插件自己的数据目录）
  const compose = join(baseDir, "docker-compose.yml")
  if (!existsSync(compose)) {
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(compose, `services:
  # 生产实例：账号出口（socks5 listener）+ 备用出口。host 网络：listener 直接绑宿主 127.0.0.1
  zcode-egress:
    image: metacubex/mihomo:v${MIHOMO_VERSION}
    container_name: zcode-egress
    restart: unless-stopped
    network_mode: host
    command: ["-d", "/root/.config/mihomo"]
    volumes:
      - ./config:/root/.config/mihomo
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # 探测实例：临时 listener 挑新节点，与生产隔离，补池时 reload 它不打断生产连接
  zcode-probe:
    image: metacubex/mihomo:v${MIHOMO_VERSION}
    container_name: zcode-probe
    restart: unless-stopped
    network_mode: host
    command: ["-d", "/root/.config/mihomo"]
    volumes:
      - ./probe-config:/root/.config/mihomo
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"
`)
  }
  const r = await sudoDocker(["compose", "-f", compose, "up", "-d"], 180_000)
  if (r.rc !== 0) return false
  return (await waitApi("http://127.0.0.1:19093")) && (await waitApi("http://127.0.0.1:19094"))
}

// —— 独立内核后端 ——

export const binDir = (baseDir) => join(baseDir, "bin")
export const binPath = (baseDir) => join(binDir(baseDir), executableName("mihomo"))
export const activeBackend = (baseDir) => {
  try { const value = JSON.parse(readFileSync(join(baseDir, "backend.json"), "utf8")); if (["docker", "binary"].includes(value.backend)) return value.backend } catch {}
  return process.platform === "linux" && existsSync(join(baseDir, "docker-compose.yml")) ? "docker" : "binary"
}

export const goosOf = () => (platform() === "win32" ? "windows" : platform() === "darwin" ? "darwin" : "linux")
export const goarchOf = () => (arch() === "arm64" ? "arm64" : arch() === "x64" ? "amd64" : arch())

export async function latestMihomoVersion(mirror = "") {
  const base = mirror ? String(mirror).replace(/\/$/, "") + "/" : ""
  const res = await fetch(`${base}https://api.github.com/repos/MetaCubeX/mihomo/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "magpie-zcode-egress" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`release HTTP ${res.status}`)
  const j = await res.json()
  return String(j?.tag_name ?? "").replace(/^v/, "")
}

// 下载 mihomo 内核（gz 包）→ 解压 → chmod +x。mirror 是 gh-proxy 之类的前缀。
export async function downloadMihomo(baseDir, { mirror = "", version } = {}) {
  const ver = version || MIHOMO_VERSION
  const asset = mihomoAsset(ver)
  const bases = mirror ? [String(mirror).replace(/\/$/, "") + "/", ""] : [""]
  const url = (b) => `${b}https://github.com/MetaCubeX/mihomo/releases/download/v${ver}/${asset}`
  mkdirSync(binDir(baseDir), { recursive: true })
  const errors = []
  for (const b of bases) {
    try {
      const archive = await downloadBytes(url(b))
      verifyMihomo(archive, asset)
      writeFileAtomic(binPath(baseDir), unpackMihomo(archive), { mode: 0o755 })
      return binPath(baseDir)
    } catch (error) { errors.push(error.message) }
  }
  throw new Error(`下载 ${asset} 失败：${errors.join("；")}。可在设置中指定下载镜像，或手动放入 ${binPath(baseDir)}`)
}

// 起独立实例（detached），返回 child pid；pidfile 供 stopBinary 使用
export async function spawnMihomo(baseDir, which) {
  const cfgDir = which === "probe" ? join(baseDir, "probe-config") : join(baseDir, "config")
  const logFile = join(baseDir, `${which}.log`)
  const out = openSync(logFile, "a", 0o600)
  let child
  try {
    child = spawn(binPath(baseDir), ["-d", cfgDir], { detached: true, windowsHide: true, stdio: ["ignore", out, out] })
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
  } finally { closeSync(out) }
  child.unref()
  writeFileSync(join(baseDir, `${which}.pid`), String(child.pid), { mode: 0o600 })
  return child.pid
}

export async function stopBinary(which, baseDir) {
  const pidFile = join(baseDir, `${which}.pid`)
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    if (pid) process.kill(pid, "SIGTERM")
  } catch {}
  try { unlinkSync(pidFile) } catch {}
}

// 统一入口：确保两个实例都在跑。docker 优先；binary 兜底（自动下载）。
export async function ensureBackend(cfg0, { log = () => {} } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDirLocal(cfg0) }
  const baseDir = cfg.baseDir
  mkdirSync(baseDir, { recursive: true })
  let backend = cfg.backend === "auto" ? null : cfg.backend
  if (backend === "docker" && process.platform !== "linux") throw new Error("Docker 后端需要 Linux host 网络；Windows / macOS 请使用自动或独立内核")
  if (!backend) {
    const { dockerOk } = await detectBackend(baseDir)
    backend = dockerOk ? "docker" : "binary"
  }
  if (backend === "docker") {
    const ok = await ensureContainers(baseDir)
    if (ok) { writeJsonAtomic(join(baseDir, "backend.json"), { backend }); return { backend: "docker", egressApi: "http://127.0.0.1:19093", probeApi: "http://127.0.0.1:19094" } }
    throw new Error("Docker 后端未就绪，请检查 Docker 与容器日志，或在设置中选择独立内核")
  }
  // binary
  mkdirSync(baseDir, { recursive: true })
  if (!existsSync(binPath(baseDir))) {
    log("下载 mihomo 内核…")
    await downloadMihomo(baseDir, { mirror: cfg.mirror })
  }
  const egressCtl = "127.0.0.1:19093"
  const probeCtl = "127.0.0.1:19094"
  writeJsonAtomic(join(baseDir, "backend.json"), { backend: "binary" })
  for (const [which, ctl] of [["egress", egressCtl], ["probe", probeCtl]]) {
    const cfgPath = which === "probe" ? join(baseDir, "probe-config", "config.yaml") : join(baseDir, "config", "config.yaml")
    if (!existsSync(cfgPath)) {
      writeConfig(cfgPath, { "mixed-port": 0, "external-controller": ctl, proxies: [], listeners: [], rules: ["MATCH,DIRECT"] })
    }
    const api = `http://${ctl}`
    const up = await waitApi(api, 2500)
    if (!up) await spawnMihomo(baseDir, which)
    if (!await waitApi(api, 30_000)) throw new Error(`mihomo ${which} 启动失败；请检查 ${join(baseDir, `${which}.log`)} 及端口 ${ctl}`)
  }
  return { backend: "binary", egressApi: `http://${egressCtl}`, probeApi: `http://${probeCtl}` }
}
