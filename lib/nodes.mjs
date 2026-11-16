// 节点来源：多个机场订阅（clash yaml）+ 手动号池（粘贴文本）。合并成一个候选池。
// 存储在 dataDir/nodes.json：
//   { subscriptions: [{ id, url, fetchedAt, nodes, nodeNames, error }], pool: { nodes, addedAt } }
// 号池支持两种粘贴格式：clash 的 proxies 列表（yaml 片段/整份配置），或每行一条
// socks5://user:pass@host:port / http://… 代理。
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { writeJsonAtomic } from "./files.mjs"
import { fetchSubscription, parseSubscription, YAML } from "./mihomo.mjs"
import { dataDir, loadConfig } from "./store.mjs"
import { nodeFingerprint } from "./node-metrics.mjs"

const sourcesPath = () => join(dataDir(), "nodes.json")

// nodes.json 现在有好几 MB（订阅全量节点定义），而 feedPage 每 5 秒要经
// sourcesSummary + listNodeNames 读它两次——按 mtime 缓存解析结果，内容没变就零开销。
// 调用方允许改写返回值后 saveSources（写盘→mtime 变→下次重新解析），语义不变。
let srcCache = { key: null, value: null }
export const loadSources = (cfg = loadConfig()) => {
  const path = sourcesPath()
  const revision = (() => { try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { return "missing" } })()
  const key = `${path}|${revision}|${cfg.subUrl ?? ""}`
  if (srcCache.value && srcCache.key === key) return srcCache.value
  let d = null
  try { d = JSON.parse(readFileSync(sourcesPath(), "utf8")) } catch {}
  // 显式空列表表示用户移除了全部订阅，不能再从旧 subUrl 恢复。
  const stored = Array.isArray(d?.subscriptions) ? d.subscriptions
    : d?.sub?.url || d?.sub?.nodes?.length ? [{ ...d.sub, url: d.sub.url || cfg.subUrl || "" }]
    : cfg.subUrl ? [{ url: cfg.subUrl }] : []
  const value = {
    subscriptions: stored.map((sub) => ({
      ...sub,
      id: sub.id || createHash("sha256").update(String(sub.url ?? "")).digest("hex").slice(0, 16),
      url: String(sub.url ?? "").trim(),
      fetchedAt: sub.fetchedAt || 0,
      nodes: Array.isArray(sub.nodes) ? sub.nodes : [],
      nodeNames: sub.nodeNames ?? Object.fromEntries((sub.nodes ?? []).map((n) => [n.name, n.name])),
      error: sub.error || "",
    })),
    pool: { nodes: [], addedAt: 0, ...(d?.pool ?? {}) },
  }
  srcCache = { key, value }
  return value
}

const saveSources = (sources) => {
  writeJsonAtomic(sourcesPath(), sources)
  srcCache = { key: null, value: null }
}

// —— 号池解析 ——

const JUNK = /流量|到期|重置|官网|网站|订阅|Emby|剩余|套餐/

// 每行一条代理：socks5://user:pass@host:port（或 http://），行尾 #名字 可选
const parseProxyLines = (text) => {
  const out = []
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(socks5|h2|http):\/\/(?:([^:@\s]+):([^@\s]*)@)?([^:@\s\/]+):(\d+)(?:#(.+))?$/.exec(line)
    if (!m) return null // 有不成行的内容 → 交给 yaml 解析
    const [, scheme, user, pass, host, port, tag] = m
    const type = scheme === "socks5" ? "socks5" : "http"
    out.push({
      type, server: host, port: Number(port), udp: type === "socks5",
      name: tag?.trim() || `${type}-${host}-${port}`,
      ...(user ? { username: decodeURIComponent(user), password: decodeURIComponent(pass) } : {}),
    })
  }
  return out
}

// clash yaml：整份配置，或只有 proxies: 列表的片段，或一行 "- {...}" 数组
export function parsePoolText(text) {
  const t = String(text ?? "").trim()
  if (!t) throw new Error("粘贴内容为空")
  const lines = parseProxyLines(t)
  if (lines && lines.length) return { nodes: lines, kind: "lines" }
  let doc
  try { doc = YAML.parse(t) } catch (e) { throw new Error("解析失败：不是可识别的代理列表或 yaml") }
  let nodes = null
  if (Array.isArray(doc)) nodes = doc
  else if (Array.isArray(doc?.proxies)) nodes = doc.proxies
  if (!nodes) throw new Error("yaml 里没有 proxies 列表")
  nodes = nodes.filter((p) => p && p.name && p.type && !JUNK.test(String(p.name)))
  if (!nodes.length) throw new Error("proxies 列表为空")
  return { nodes, kind: "yaml" }
}

// 合并去重：同名保留后者（新导入覆盖旧的）
const mergeNodes = (a, b) => {
  const map = new Map()
  for (const n of a ?? []) map.set(n.name, n)
  for (const n of b ?? []) map.set(n.name, n)
  return [...map.values()]
}

export const importPool = (text, { replace = false } = {}) => {
  const { nodes, kind } = parsePoolText(text)
  const sources = loadSources()
  sources.pool = {
    nodes: replace ? nodes : mergeNodes(sources.pool.nodes, nodes),
    addedAt: Date.now(),
  }
  saveSources(sources)
  return { added: nodes.length, total: sources.pool.nodes.length, kind }
}

export const clearPool = () => {
  const sources = loadSources()
  sources.pool = { nodes: [], addedAt: 0 }
  saveSources(sources)
}

// —— 订阅 ——

export const parseSubscriptionUrls = (input) => {
  const values = Array.isArray(input) ? input : [input]
  if (values.some((v) => typeof v !== "string")) throw new Error("订阅地址需为文本或链接列表")
  const lines = values.flatMap((v) => v.split(/\r?\n/))
  const urls = []
  for (let i = 0; i < lines.length; i++) {
    const value = lines[i].trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (!/^https?:$/.test(url.protocol) || /\s/.test(value)) throw new Error()
      urls.push(url.href)
    } catch { throw new Error(`第 ${i + 1} 行需填写完整的 http:// 或 https:// 订阅链接`) }
  }
  if (!urls.length) throw new Error("先填订阅地址")
  return [...new Set(urls)]
}

const sameUrl = (a, b) => {
  try { return new URL(a).href === new URL(b).href } catch { return a === b }
}
const addSubscription = (sources, url) => {
  let sub = sources.subscriptions.find((s) => sameUrl(s.url, url))
  if (!sub) {
    sub = { id: randomUUID(), url, fetchedAt: 0, nodes: [], nodeNames: {}, error: "" }
    sources.subscriptions.push(sub)
  }
  return sub
}

// 兼容旧 configure.subUrl：保存时追加，不覆盖其它机场。
export const saveSubUrl = (url, cfg = loadConfig()) => {
  const urls = parseSubscriptionUrls(url)
  if (urls.length !== 1) throw new Error("此处只能填写一个地址；多个订阅请在面板中导入")
  const sources = loadSources(cfg)
  const sub = addSubscription(sources, urls[0])
  saveSources(sources)
  return sub
}

// 同名机场节点保留独立定义；持久化别名，刷新或移除其它订阅后名字仍保持不变。
const nameSubscriptionNodes = (sub, nodes, sources) => {
  const aliases = new Map(Object.entries(sub.nodeNames))
  const reserved = new Set(sources.subscriptions.filter((s) => s.id !== sub.id)
    .flatMap((s) => [...s.nodes.map((n) => n.name), ...Object.values(s.nodeNames)]))
  const ownNames = new Set(aliases.values())
  const named = mergeNodes([], nodes).map((node) => {
    let name = aliases.get(node.name)
    if (!name || reserved.has(name)) {
      name = node.name
      const stem = `${node.name} [${sub.id.slice(0, 8)}]`
      let i = 1
      while (reserved.has(name) || ownNames.has(name)) name = stem + (i++ > 1 ? ` ${i - 1}` : "")
      aliases.set(node.name, name)
      ownNames.add(name)
    }
    reserved.add(name)
    return { ...node, name }
  })
  return { nodes: named, nodeNames: Object.fromEntries(aliases) }
}

const refreshOne = async (cfg, target) => {
  let nodes, error = ""
  try {
    const text = await fetchSubscription(target.url)
    try { nodes = parseSubscription(text) } catch { throw new Error("订阅不是有效的 Clash YAML 配置") }
    if (!nodes.length) throw new Error("订阅中没有可用节点（需要 Clash YAML 格式）")
  } catch (e) { error = String(e?.message ?? e).slice(0, 200) }

  // 网络请求期间号池或其它订阅可能已修改；提交时重读，避免覆盖这些修改。
  const sources = loadSources(cfg)
  const sub = sources.subscriptions.find((s) => s.id === target.id && s.url === target.url)
  if (!sub) return { subscriptionId: target.id, count: 0, error: "订阅已移除或修改，已忽略此次更新" }
  if (!error) Object.assign(sub, nameSubscriptionNodes(sub, nodes, sources), { fetchedAt: Date.now() })
  sub.error = error
  saveSources(sources)
  return { subscriptionId: sub.id, count: sub.nodes.length, error }
}

// urls/url：追加导入；subscriptionId：更新或改地址；都不传：更新全部。
export const refreshSubscriptions = async (cfg, { urls, url, subscriptionId } = {}) => {
  const sources = loadSources(cfg)
  const input = urls ?? url
  const wanted = input === undefined ? null : parseSubscriptionUrls(input)
  let targets
  if (subscriptionId) {
    const sub = sources.subscriptions.find((s) => s.id === subscriptionId)
    if (!sub) throw new Error("找不到该订阅，请刷新面板")
    if (wanted && wanted.length !== 1) throw new Error("更换地址时只能填写一个链接")
    const nextUrl = wanted?.[0] ?? parseSubscriptionUrls(sub.url)[0]
    if (sources.subscriptions.some((s) => s.id !== sub.id && sameUrl(s.url, nextUrl))) throw new Error("该订阅地址已存在")
    sub.url = nextUrl
    targets = [sub]
  } else if (wanted) targets = wanted.map((value) => addSubscription(sources, value))
  else targets = sources.subscriptions.filter((s) => s.url)
  if (!targets.length) throw new Error("没有订阅地址")
  saveSources(sources)

  const results = new Array(targets.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (cursor < targets.length) {
      const i = cursor++
      results[i] = await refreshOne(cfg, targets[i])
    }
  }))
  const failed = results.filter((r) => r.error).length
  const summary = await sourcesSummary(cfg)
  return { count: summary.sub.count, succeeded: results.length - failed, failed, results }
}

export const removeSubscription = (cfg, subscriptionId) => {
  const sources = loadSources(cfg)
  const index = sources.subscriptions.findIndex((s) => s.id === subscriptionId)
  if (index < 0) throw new Error("找不到该订阅，请刷新面板")
  sources.subscriptions.splice(index, 1)
  saveSources(sources)
}

const allNodes = (sources) => mergeNodes(sources.subscriptions.flatMap((s) => s.nodes), sources.pool.nodes)
export const cachedProxies = (cfg) => allNodes(loadSources(cfg))

// 全部可用节点；仅补拉没有缓存的订阅，单个机场失败不影响其它来源。
export const readNodes = async (cfg) => {
  const missing = loadSources(cfg).subscriptions.filter((s) => s.url && !s.nodes.length)
  if (missing.length) {
    try { await refreshSubscriptions(cfg, { urls: missing.map((s) => s.url) }) } catch {}
  }
  return allNodes(loadSources(cfg))
}

// 节点清单与实际候选池保持相同的去重顺序（号池覆盖同名项）。
export const listNodeNames = (cfg) => {
  const sources = loadSources(cfg), names = new Map()
  const describe = (node) => ({ name: node.name, type: node.type || "unknown", server: String(node.server || ""), port: Number(node.port) || null, fingerprint: nodeFingerprint(node) })
  for (const sub of sources.subscriptions) {
    for (const n of sub.nodes) names.set(n.name, { ...describe(n), src: "sub", subscriptionId: sub.id })
  }
  for (const n of sources.pool.nodes) names.set(n.name, { ...describe(n), src: "pool" })
  return [...names.values()]
}

export const sourcesSummary = async (cfg) => {
  const s = loadSources(cfg)
  const subscriptions = s.subscriptions.map((sub) => ({
    id: sub.id, url: sub.url, count: sub.nodes.length, fetchedAt: sub.fetchedAt, error: sub.error,
  }))
  return {
    subscriptions,
    // sub.count 保留为订阅节点合计，兼容尚未刷新的旧页面。
    sub: { url: subscriptions[0]?.url ?? "", count: mergeNodes([], s.subscriptions.flatMap((sub) => sub.nodes)).length,
      fetchedAt: Math.max(0, ...subscriptions.map((s) => s.fetchedAt)), error: subscriptions.find((s) => s.error)?.error ?? "" },
    pool: { count: s.pool.nodes.length, addedAt: s.pool.addedAt || 0 },
    total: allNodes(s).length,
  }
}
