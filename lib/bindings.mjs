// 绑定层：{provider, account} → 本地 socks5 端口。
//
// state.json（mihomo 层）只认端口；bindings.json（magpie 层）把账号钉到端口上。
// 以前 zcode 靠「别名序 × 端口序」位置配对，账号一增删就整体漂移；统一管理后
// 绑定显式落盘，新账号只追加端口，老账号的出口 IP 永远不变（固定绑定）。
//
// bindings.json 结构（dataDir 下，与旧 cron 完全隔离）：
//   { version: 1, at, bindings: { providerId: { accountId: { port, at, mode, extra?, front?, strategy? } } } }
//   mode: "migrated"(迁移原样保留) | "auto"(自动分配) | "manual"(面板手动指定)
//   port: null 表示待分配（assign 时补上）
//   extra / front / strategy: 单 Key 多出口时才有，见下方「单 Key 多出口」
import { join } from "node:path"
import { readJson as readJSON, writeJsonAtomic } from "./files.mjs"
import { dataDir, loadConfig, saveConfig } from "./store.mjs"
import { listProviders, parseProxyPort, managedIds } from "./providers.mjs"

const bindingsPath = () => join(dataDir(), "bindings.json")

export const loadBindings = () => readJSON(bindingsPath(), null)

export function saveBindings(b) {
  writeJsonAtomic(bindingsPath(), b)
}

// 端口分配：portBase 起步，跳过已绑端口、备用段（spareBase..spareBase+spares 段长）、
// 探测段（probePortBase 起 256 个）和 mihomo 控制器端口。找不到返回 null。
export function allocPort(cfg, used, sparesLen = 0) {
  const base = Number(cfg?.portBase) || 17901
  const spareBase = Number(cfg?.spareBase) || 17931
  const spareEnd = spareBase + Math.max(Number(cfg?.sparesCount) || 8, sparesLen, 1)
  const probeBase = Number(cfg?.probePortBase) || 18200
  const reserved = new Set([19093, 19094])
  for (let p = Math.max(1, base); p <= 65535 && p < base + 4000; p++) {
    if (used.has(p) || reserved.has(p)) continue
    if (p >= spareBase && p < spareEnd) continue
    if (p >= probeBase && p < probeBase + 256) continue
    return p
  }
  return null
}

// —— 单 Key 多出口 ——
//
// magpie 每个账号/Key 只能配一个代理地址。一个绑定要走多个出口时：
//   port   主出口端口（领取等必须固定 IP 的流程只用它）
//   extra  追加的出口端口；每个都是 state.assignments 里的普通出口
//   front  本地入口端口：mihomo 的 load-balance 组监听在这里，magpie 指向它
//   strategy 入口的分流策略（见 lib/mihomo.mjs 的 LB_STRATEGIES）
// 只有一个出口的绑定没有 extra / front / strategy，行为与以前完全相同。
// MAX_EXITS 是硬上限；每个账号实际允许的数量由配置 maxExits 决定（默认 8）。
export const MAX_EXITS = 64
export const DEFAULT_MAX_EXITS = 8
export const exitsLimit = (cfg) => {
  const n = Number(cfg?.maxExits)
  return Number.isInteger(n) && n >= 2 ? Math.min(n, MAX_EXITS) : DEFAULT_MAX_EXITS
}
const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535

// 该绑定的全部出口端口，主出口在前
export function exitPortsOf(bind) {
  if (!bind?.port) return []
  const ports = [Number(bind.port)]
  for (const value of Array.isArray(bind.extra) ? bind.extra : []) {
    const port = Number(value)
    if (validPort(port) && !ports.includes(port)) ports.push(port)
  }
  return ports
}
export const isMultiExit = (bind) => validPort(Number(bind?.front)) && exitPortsOf(bind).length > 1
// magpie 实际应指向的端口：多出口时是入口，否则就是主出口
export const proxyPortOf = (bind) => isMultiExit(bind) ? Number(bind.front) : bind?.port ? Number(bind.port) : null
export const proxyUrlOf = (bind) => {
  const port = proxyPortOf(bind)
  return port ? `socks5://127.0.0.1:${port}` : null
}
// 配置生成用的入口清单（唯一来源）：[{ port, members, strategy, provider, account }]
export function frontsOf(b) {
  const out = []
  for (const [pid, accounts] of Object.entries(b?.bindings ?? {}))
    for (const [acc, bind] of Object.entries(accounts ?? {}))
      if (isMultiExit(bind)) out.push({ port: Number(bind.front), members: exitPortsOf(bind), strategy: bind.strategy, provider: pid, account: acc })
  return out
}

// 全部绑定占用的端口：出口端口 + 入口端口（port 为 null 的跳过）
export function bindingPorts(b) {
  const used = new Set()
  for (const accounts of Object.values(b?.bindings ?? {}))
    for (const bind of Object.values(accounts ?? {})) {
      for (const port of exitPortsOf(bind)) used.add(port)
      if (validPort(Number(bind?.front))) used.add(Number(bind.front))
    }
  return used
}

// 出口端口 → {provider, account, bind} 反查（追加出口与主出口同属一个账号）
export function portOwners(b) {
  const map = new Map()
  for (const [pid, accounts] of Object.entries(b?.bindings ?? {}))
    for (const [acc, bind] of Object.entries(accounts ?? {}))
      for (const port of exitPortsOf(bind)) map.set(port, { provider: pid, account: acc, bind })
  return map
}

export const bindingOf = (b, provider, account) => b?.bindings?.[provider]?.[account] ?? null

export const countPending = (b) => {
  let n = 0
  for (const accounts of Object.values(b?.bindings ?? {}))
    for (const bind of Object.values(accounts ?? {}))
      if (!bind?.port) n++
  return n
}

// —— 迁移：第一次以统一管理身份接管现有 accountProxies ——
//
// 原则：现有绑定原样钉住（zcode 20 个账号的出口 IP 一个都不动）。同一端口被多个
// 账号引用（如 amd 的 key 曾指到 zcode 的端口段）属于冲突，全部标 pending，等
// assign 用新端口 + 去重新出口补齐。默认接管面 = 已经有 accountProxies 的供应商。
export function migrateBindings(cfg0, { log = () => {} } = {}) {
  const existing = loadBindings()
  if (existing) return { bindings: existing, migrated: false }
  const cfg = { ...loadConfig(), ...cfg0 }
  const provs = listProviders()
  const managed = managedIds(cfg, provs)
  const now = Math.floor(Date.now() / 1000)
  // 每个端口的引用者：{pid, acc, kind}
  const refs = new Map()
  for (const pid of managed) {
    const p = provs.find((x) => x.id === pid)
    if (!p) continue
    for (const [acc, url] of Object.entries(p.proxies ?? {})) {
      const port = parseProxyPort(url)
      if (!port) continue
      if (!refs.has(port)) refs.set(port, [])
      refs.get(port).push({ pid, acc, kind: provs.find((x) => x.id === pid)?.kind ?? "keys" })
    }
  }
  // 端口归属裁决：一处引用 → 直接钉住；多处引用（如 Key 撞进登录账号的端口段）
  // 优先钉登录型账号（Key 是可再分配资源），同型按白名单顺序，落选者标待分配。
  const rank = (r, idx) => ({ login: 0, mixed: 1, keys: 2 })[r.kind] * 1000 + managed.indexOf(r.pid) * 10 + idx
  const winner = new Map() // port → ref
  for (const [port, list] of refs) {
    let best = null
    let bestRank = Infinity
    list.forEach((r, i) => {
      const k = rank(r, i)
      if (k < bestRank) { bestRank = k; best = r }
    })
    winner.set(port, best)
    if (list.length > 1) log(`迁移：端口 ${port} 有 ${list.length} 处引用，钉住 ${best.pid}/${best.acc}，其余待分配`)
  }
  const bindings = {}
  for (const pid of managed) bindings[pid] = {}
  for (const [port, ref] of winner) bindings[ref.pid][ref.acc] = { port, at: now, mode: "migrated" }
  for (const pid of managed) {
    const p = provs.find((x) => x.id === pid)
    if (!p) continue
    for (const a of p.accounts) {
      if (bindings[pid][a.id]) continue
      bindings[pid][a.id] = { port: null, at: now, mode: "pending" }
      log(`迁移：${pid}/${a.id} 标为待分配${p.proxies?.[a.id] != null ? "（原端口归属冲突）" : "（原本就没配出口）"}`)
    }
  }
  const saved = { version: 1, at: now, bindings }
  saveBindings(saved)
  if (!Array.isArray(cfg.managedProviders)) {
    saveConfig({ ...cfg, managedProviders: managed })
    log(`统一出口接管：${managed.join(", ")}（可随时在设置里调整白名单）`)
  }
  const pending = countPending(saved)
  log(`绑定迁移完成：${winner.size} 个原样钉住，${pending} 个待分配`)
  return { bindings: saved, migrated: true, managed, pending }
}

// 待分配清单：[{provider, account, label}]，只针对受管供应商。
//   - binding 缺失或 port 为 null 的账号；指定 provider 时只看它
export function pendingList(b, cfg, { provider } = {}) {
  const provs = listProviders()
  const managed = managedIds(cfg, provs)
  const targets = provider ? [provider] : managed
  const out = []
  for (const pid of targets) {
    const p = provs.find((x) => x.id === pid)
    if (!p) continue
    const accounts = b?.bindings?.[pid] ?? {}
    for (const a of p.accounts) {
      const bind = accounts[a.id]
      if (!bind || !bind.port) out.push({ provider: pid, account: a.id, label: a.label })
    }
  }
  return out
}

// 清理孤儿绑定：账号/Key 在 magpie 侧已彻底消失（登录态、Key、accountNames 三处
// 都没了——Key 被删、账号被登出等）时，binding 还钉着端口不放，端口永远占着、
// accountProxies 里也会留孤儿条目。清掉绑定并归还端口。
// 保守护栏：账号枚举为空而 accountProxies 还有记录的供应商整家跳过（logins.json
// 短暂读不到时不至于把全家的端口都放了）；枚举 = 登录 ∪ Key ∪ accountNames，
// accountNames 里还在的名字一律视为存在，不清理。
export function pruneOrphanBindings(cfg, { log = () => {} } = {}) {
  const b = loadBindings()
  if (!b) return { ok: false, why: "bindings.json 不存在" }
  const provs = listProviders()
  const managed = managedIds(cfg, provs)
  const freed = []
  for (const pid of managed) {
    const p = provs.find((x) => x.id === pid)
    if (!p) continue
    if (!p.accounts.length && Object.keys(p.proxies ?? {}).length) {
      log(`⚠ ${pid} 账号枚举为空但 accountProxies 有记录，跳过孤儿清理`)
      continue
    }
    const ids = new Set(p.accounts.map((a) => a.id))
    const accounts = b.bindings?.[pid] ?? {}
    for (const acc of Object.keys(accounts)) {
      if (ids.has(acc)) continue
      const port = accounts[acc]?.port ?? null
      const ports = exitPortsOf(accounts[acc])
      delete b.bindings[pid][acc]
      freed.push({ provider: pid, account: acc, port, ports })
      log(`清理孤儿绑定：${pid}/${acc}${ports.length ? `（释放 ${ports.map((p) => ":" + p).join(" ")}）` : ""}`)
    }
    if (b.bindings[pid] && !Object.keys(b.bindings[pid]).length) delete b.bindings[pid]
  }
  if (!freed.length) return { ok: true, pruned: 0, freed }
  saveBindings(b)
  return { ok: true, pruned: freed.length, freed }
}
