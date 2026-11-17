// 出口管理：挑候选（跨 /24）→ 探出口 IP + zcode TLS 延迟 → 排序去重 → 分配
// 端口 → 健康检查 → 坏端口换备用 → 对齐 magpie 的 accountProxies。
//
// 统一管理：所有受管供应商（cfg.managedProviders 白名单）的账号/Key 共用同一个
// 端口池与备用池；绑定关系在 bindings.json（lib/bindings.mjs），对齐 magpie 走
// syncAll（每个供应商只改自己的 accountProxies）。
//
// 互斥：所有会动 mihomo/配置的操作由调用方（server.mjs / egress-cli.mjs）用
// flock 包住（flock -n /tmp/zcode-egress.lock），与 /opt/zcode-egress 旧 cron
// 的 egress.py check 同一把锁，谁先抢到谁做。
import { readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { readJson, writeFileAtomic, writeJsonAtomic } from "./files.mjs"
import { isIpv4, proxiedFetch } from "./socks.mjs"
import { buildEgressConfig, writeConfig, reloadConfig, waitApi, ensureBackend, selectNode, restartEgressContainer, uniqProxies, activeBackend, apiCall, frontName, LB_STRATEGIES, LB_TEST_URL } from "./mihomo.mjs"
import { readNodes, cachedProxies } from "./nodes.mjs"
import { recordNodeTests } from "./node-metrics.mjs"
import { resolveBaseDir } from "./store.mjs"
import { setProviderAccountProxies } from "./accounts.mjs"
import { loadBindings, saveBindings, migrateBindings, bindingPorts, portOwners, allocPort, pendingList, pruneOrphanBindings, exitPortsOf, frontsOf, proxyUrlOf, isMultiExit, MAX_EXITS, exitsLimit } from "./bindings.mjs"
import { listProviders, managedIds } from "./providers.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EGRESS_CONTROLLER = "127.0.0.1:19093"
export const EGRESS_API = `http://${EGRESS_CONTROLLER}`
export const PROBE_API = "http://127.0.0.1:19094"
const CONFIG_IN_CONTAINER = "/root/.config/mihomo/config.yaml"
const configPath = (cfg) => join(cfg.baseDir, "config", "config.yaml")

// 生产配置的唯一生成点：state（端口→节点、备用池）+ bindings（多出口入口）。
// 重建、换绑、修复三条路径都从这里出配置，入口组不会在某条路径上被漏掉。
function egressConfig(cfg, st, proxies, { assignments = st.assignments ?? {}, bindings = loadBindings() } = {}) {
  return buildEgressConfig({
    proxies, assignments, spares: st.spares ?? [], sparePortBase: cfg.spareBase,
    controller: EGRESS_CONTROLLER, withGroups: !!st.withGroups, fronts: frontsOf(bindings),
  })
}

// 新建的 state 一律用 selector 组模式：换节点走 API 即时生效，不必重载整份配置。
const freshState = () => ({ assignments: {}, spares: [], withGroups: true, created: Date.now() / 1000 })
const spareRange = (cfg, st) => {
  const length = Math.max(st.spares?.length ?? 0, Number(cfg.sparesCount) || 8)
  return Array.from({ length }, (_, i) => Number(cfg.spareBase) + i)
}
const takenPorts = (cfg, st, b) => new Set([...bindingPorts(b), ...Object.keys(st.assignments ?? {}).map(Number), ...spareRange(cfg, st)])
const takenNodes = (st) => new Set([...Object.values(st.assignments ?? {}).map((v) => v?.node), ...(st.spares ?? []).map((s) => s?.node)].filter(Boolean))
const takenIps = (st) => new Set([...Object.values(st.assignments ?? {}).map((v) => v?.ip), ...(st.spares ?? []).map((s) => s?.ip)].filter(Boolean))

const IP_ENDPOINTS = ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"]
const ZCODE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
const ZCODE_UA = "ZCode/3.16.3"
const NET_TIMEOUT = 12
export const PROBE_WORKERS = 40
export const CHECK_WORKERS = 16
const IPV4_NET = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/
const ZCODE_INTERVAL = 3600
const RETRY_AFTER = 1800      // 候选不足后，隔多久再做一次整池探测（秒）
const SPARE_MISS_LIMIT = 3    // 备用出口连续几轮探不到 IP 就摘除

// 备用池归一化：把「已经挂成主出口」的节点从备用池里摘掉。
// 两处同名会在重建配置时写出两条同名 proxy，mihomo 启动即 fatal、容器无限重启，
// 全部 socks5 端口消失 ⇒ magpie 报「502·代理连不上」（2026-11-14 事故根因：
// 换绑时把一个备用节点给了账号，备用池里没摘掉）。
export function dedupeSpares(st) {
  const mainNodes = new Set(Object.values(st?.assignments ?? {}).map((v) => v?.node).filter(Boolean))
  const before = st?.spares ?? []
  const spares = before.filter((s) => s?.node && !mainNodes.has(s.node))
  return { spares, dropped: before.length - spares.length, droppedNodes: before.filter((s) => !s?.node || mainNodes.has(s.node)).map((s) => s?.node) }
}

// 从 state 重建一份干净配置并重启后端 —— 给「盘上的 config.yaml 已被写成 mihomo
// 拒载的样子、容器在 crash loop」这条路径兜底（此时 API 根本不通，没法 reload）。
export async function repairDiskConfig(cfg0, ctx) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const st = loadState(cfg)
  if (!st) throw new Error("没有 state.json，无法重建配置")
  const { spares, dropped, droppedNodes } = dedupeSpares(st)
  if (dropped) {
    st.spares = spares
    ctx.log(`  备用池摘掉 ${dropped} 个与主出口撞名的节点：${droppedNodes.filter(Boolean).join(", ")}`)
  }
  const proxies = await fetchProxies(cfg)
  writeConfig(configPath(cfg), egressConfig(cfg, st, proxies))
  saveState(cfg, st)
  if (activeBackend(cfg.baseDir) === "docker") await restartEgressContainer("zcode-egress")
  else await ensureBackend(cfg, { log: ctx.log })
  const up = await waitApi(EGRESS_API, 60_000)
  ctx.log(up ? "配置已重建，mihomo 恢复" : "⚠ 配置已重建但 API 仍不通（看 docker logs zcode-egress）")
  return up
}

// mihomo API 不通时按配置拉起后端（docker 优先，独立内核兜底）；失败只告警不阻断
export async function ensureEgressApi(cfg, ctx) {
  if (await waitApi(EGRESS_API, 1500)) return true
  ctx.log("mihomo API 不通，尝试拉起后端（docker/独立内核）…")
  try {
    const b = await ensureBackend(cfg, { log: ctx.log })
    ctx.log(`后端就绪（${b.backend}）`)
    if (await waitApi(EGRESS_API, 8000)) return true
    // 后端起得来但 API 一直不通：多半是盘上的配置被 mihomo 拒载（会无限重启）。
    ctx.log("⚠ 后端已启动但 API 仍不通，按 state 重建配置后重启…")
    return await repairDiskConfig(cfg, ctx)
  } catch (e) {
    ctx.log(`⚠ 后端拉起失败：${String(e?.message ?? e).slice(0, 160)}`)
    return false
  }
}

// —— 节点来源与候选 ——

// 候选节点 = 订阅缓存 + 手动号池（nodes.mjs 管）；都没有且继承了旧目录时读 sub_url.txt
export async function fetchProxies(cfg) {
  cfg = { ...cfg, baseDir: resolveBaseDir(cfg) }
  const nodes = await readNodes(cfg)
  if (!nodes.length) throw new Error("没有可用节点来源（先导入订阅或号池）")
  return nodes
}

// 多出口入口组里被判死的成员，换了节点也不会自己复活（mihomo v1.19.34 实测：
// 要等下一轮组健康检查）。即时换节点后主动触发一次组测速，新节点马上回到轮换里。
export async function reviveFront(port, { call = apiCall, bindings = loadBindings() } = {}) {
  const bind = portOwners(bindings).get(Number(port))?.bind
  if (!isMultiExit(bind)) return false
  try {
    const r = await call(EGRESS_API, `/group/${encodeURIComponent(frontName(bind.front))}/delay?url=${encodeURIComponent(LB_TEST_URL)}&timeout=5000`, { timeoutMs: 9000 })
    return r.ok
  } catch { return false }
}

// 已加载的备用节点走 selector 即时切换；普通候选或旧式配置先重建并加载配置。
// 重载时每组仍以自己的节点为首选，保留其它账号的绑定。调用方需持 flock。
export async function swapPort(cfg, ctx, port, node, { io = {} } = {}) {
  const select = io.select ?? selectNode
  const source = io.proxies ?? fetchProxies
  const reload = io.reload ?? reloadConfig
  const ready = io.ready ?? waitApi
  const pause = io.pause ?? sleep
  const probe = io.probe ?? exitIp
  const revive = io.revive ?? reviveFront
  cfg = { ...cfg, baseDir: resolveBaseDir(cfg) }
  const st = loadState(cfg)
  if (!st?.assignments?.[String(port)]) throw new Error(`端口 ${port} 没有分配记录`)
  const old = st.assignments[String(port)]
  if (old.node === node) return { ok: true, changed: false, port, node }

  // 换绑前先查占用：同一节点只能挂一个端口。
  //   已被别的账号占着 → 拒绝（两个账号会共用同一出口 IP，且配置会写重名）；
  //   还在备用池里     → 与本端口旧节点换位（备用位不空，主备两池始终不相交）。
  const otherMain = Object.entries(st.assignments).find(([p, v]) => Number(p) !== Number(port) && v?.node === node)
  if (otherMain) throw new Error(`节点 ${node} 已绑定在 :${otherMain[0]}，不能复用（同一出口 IP 挂两个账号没意义）`)
  st.spares ??= []
  const spareIdx = st.spares.findIndex((s) => s?.node === node)
  const sparePort = spareIdx >= 0 ? Number(cfg.spareBase) + spareIdx : null
  ctx.log(`SWAP ${port}: ${old.node} → ${node}${sparePort ? `（与备用 :${sparePort} 换位）` : ""}`)

  const applySpare = () => {
    if (spareIdx >= 0) st.spares[spareIdx] = { node: old.node, ip: old.ip ?? null }
  }
  // 运行中的组里只有生成配置时的备用节点；换过位的备用不在组里，选不中就走重载。
  const viaSelect = st.withGroups && spareIdx >= 0 && await select(EGRESS_API, `eg-${port}`, node)
  if (viaSelect) {
    if (sparePort) {
      // 备用位接手旧节点：组里本来就有这个节点，直接选中即可，不用 reload。
      // 偶发失败（API 抖动）重试一次；仍失败留 warn，下轮重建配置时按 state 归位。
      let ok2 = await select(EGRESS_API, `spare-${sparePort}`, old.node)
      if (!ok2) { await pause(600); ok2 = await select(EGRESS_API, `spare-${sparePort}`, old.node) }
      if (!ok2) ctx.log(`⚠ 备用位 :${sparePort} 换位失败（下轮体检会按 state 修正）`)
    }
    applySpare()
    await revive(port)
  } else {
    const proxies = await source(cfg)
    const assignments = { ...st.assignments, [String(port)]: { node, ip: null } }
    applySpare()
    const conf = egressConfig(cfg, st, proxies, { assignments })
    const path = configPath(cfg)
    let previous = null, written = false
    try { previous = readFileSync(path) } catch (error) { if (error.code !== "ENOENT") throw error }
    try {
      writeConfig(path, conf)
      written = true
      if (!await reload(EGRESS_API, "zcode-egress", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir })) throw new Error("mihomo 配置加载失败，换绑未完成")
      if (!await ready(EGRESS_API)) throw new Error("mihomo 重载后未就绪，换绑未完成")
      await pause(1500)
    } catch (error) {
      // 不把失败的换绑留在磁盘，避免下一次启动意外切到未确认的节点。
      if (written) {
        if (previous) {
          writeFileAtomic(path, previous)
          try {
            if (!await reload(EGRESS_API, "zcode-egress", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir })) ctx.log("⚠ 原配置已恢复到磁盘，mihomo 暂未恢复")
          } catch { ctx.log("⚠ 原配置已恢复到磁盘，mihomo 暂未恢复") }
        } else unlinkSync(path)
      }
      throw error
    }
  }
  const ip = await probe(port)
  st.assignments[String(port)] = { node, ip: ip ?? null }
  st.last_check ??= { ts: Date.now() / 1000, ports: {} }
  st.last_check.ports ??= {}
  st.last_check.ports[String(port)] = { node, ip: ip ?? null, zcode: "skip", checkedAt: Date.now() }
  if (st.last_zcode) delete st.last_zcode[String(port)]
  saveState(cfg, st)
  ctx.log(`  ${port} 新出口 IP: ${ip ?? "?"}`)
  return { ok: true, changed: true, port, node, ip }
}

const netOf = (server) => {
  const m = IPV4_NET.exec(String(server ?? ""))
  if (!m) return server || "?"
  return m[1].split(".").slice(0, 3).join(".") + ".0/24"
}

export function pickCandidates(proxies, limit, exclude = new Set()) {
  const byNet = new Map()
  for (const p of proxies) {
    const key = netOf(p.server)
    if (!byNet.has(key)) byNet.set(key, [])
    byNet.get(key).push(p.name)
  }
  for (const arr of byNet.values()) arr.sort()
  const order = [...byNet.keys()].sort((a, b) => byNet.get(b).length - byNet.get(a).length)
  const picked = []
  const used = new Set(exclude)
  let round = 0
  while (picked.length < limit) {
    let added = false
    for (const net of order) {
      const bucket = byNet.get(net)
      if (round >= bucket.length) continue
      const node = bucket[round]
      added = true
      if (used.has(node)) continue
      picked.push(node)
      used.add(node)
      if (picked.length >= limit) break
    }
    if (!added) break
    round++
  }
  return picked
}

// —— 探测：原生 SOCKS5 / TLS，不依赖 curl 或 Unix 设备路径 ——

export async function exitIp(port, timeout = NET_TIMEOUT) {
  let first = true
  for (const url of IP_ENDPOINTS) {
    try {
      // 第一个地址用完整超时；它都不通时，后面的只是换个查询站再确认一次，不必等同样久。
      const r = await proxiedFetch(url, { proxy: `socks5://127.0.0.1:${port}`, timeoutMs: (first ? timeout : Math.min(timeout, 6)) * 1000 })
      const out = r.text.trim()
      if (r.status === 200 && isIpv4(out)) return out
    } catch (error) {
      // 本地端口没人监听：换查询站也没用，立即返回。
      if (error?.code === "ECONNREFUSED") return null
    }
    first = false
  }
  return null
}

export async function zcodeProbe(port, timeout = 20) {
  try {
    const r = await proxiedFetch(ZCODE_URL, { proxy: `socks5://127.0.0.1:${port}`, method: "POST", headers: { "content-type": "application/json", "user-agent": ZCODE_UA }, body: "{}", timeoutMs: timeout * 1000 })
    return { code: String(r.status), tls: r.tlsMs === null ? null : r.tlsMs / 1000, total: r.ms / 1000 }
  } catch { return { code: "000", tls: null, total: null } }
}

const mapPool = async (items, workers, fn) => {
  const out = new Array(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (e) { out[i] = { error: String(e?.message ?? e) } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, Math.max(1, items.length)) }, run))
  return out
}

export const probePorts = (ports, workers = PROBE_WORKERS) => mapPool(ports, workers, (p) => exitIp(p))
const detailedZcodePorts = (ports, workers = CHECK_WORKERS) => mapPool(ports, workers, (p) => zcodeProbe(p))

// Inspect a small, explicitly chosen set through the separate probe instance.
// It never selects a production group or writes account bindings/state.
export async function inspectNodes(cfg0, ctx, names, { io = {} } = {}) {
  if (!Array.isArray(names) || !names.length || names.length > 20 || names.some((name) => typeof name !== "string" || !name.trim() || name.length > 256 || /[\x00-\x1f]/.test(name))) throw new Error("每次请选择 1–20 个有效节点")
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }, wanted = [...new Set(names)]
  const proxies = await (io.proxies ?? fetchProxies)(cfg), definitions = new Map(proxies.map((node) => [node.name, node]))
  if (wanted.some((name) => !definitions.has(name))) throw new Error("节点已移除或不存在，请刷新列表")
  const base = Number(cfg.probePortBase) || 18200
  if (!Number.isInteger(base) || base < 1 || base + wanted.length - 1 > 65535) throw new Error("探测端口超出有效范围")
  const ports = wanted.map((_, i) => base + i)
  const prepare = io.prepare ?? (async () => {
    await resetProbe(cfg)
    writeConfig(join(cfg.baseDir, "probe-config", "config.yaml"), {
      "mixed-port": 0, "allow-lan": false, mode: "rule", "log-level": "warning", ipv6: false,
      "external-controller": "127.0.0.1:19094", "unified-delay": true, "tcp-concurrent": true,
      proxies: wanted.map((name) => definitions.get(name)),
      listeners: ports.map((port, i) => ({ name: `probe-${port}`, type: "socks", port, listen: "127.0.0.1", proxy: wanted[i], udp: false })),
      rules: ["MATCH,DIRECT"],
    })
    const reloadProbe = async () => { try { return await reloadConfig(PROBE_API, "zcode-probe", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir }) } catch { return false } }
    if (!await reloadProbe()) {
      await ensureBackend(cfg, { log: ctx.log })
      if (!await reloadProbe()) throw new Error("探测服务未就绪")
    }
    await sleep(800)
  })
  try {
    await prepare(cfg, wanted, ports)
    const results = await mapPool(ports, 6, async (port, i) => {
      const measured = await (io.measure ?? (async (p) => {
        const [ip, response] = await Promise.all([exitIp(p, 8), zcodeProbe(p, 12)])
        return { ip, ...response }
      }))(port, wanted[i])
      return { node: wanted[i], ...measured }
    })
    const entries = results.map((result, i) => ({ ...result, node: wanted[i] }))
    const saved = recordNodeTests(proxies, entries, { source: "manual" })
    const reachable = wanted.filter((name) => saved[name]?.status === "reachable").length
    ctx.log(`节点测试完成：${wanted.length} 个，${reachable} 个目标可达；账号绑定未变更`)
    return { ok: true, tested: wanted.length, reachable }
  } finally {
    try { if (await (io.reset ?? resetProbe)(cfg) === false) ctx.log("⚠ 探测服务清理未完成，下次测试会重置") }
    catch { ctx.log("⚠ 探测服务清理未完成，下次测试会重置") }
  }
}

// —— 候选池探测（probe 实例，用完即复位） ——

export async function resetProbe(cfg0) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  try {
    writeConfig(join(cfg.baseDir, "probe-config", "config.yaml"), {
      "mixed-port": 0, "allow-lan": false, mode: "rule", "log-level": "warning", ipv6: false,
      "external-controller": "127.0.0.1:19094", "unified-delay": true, "tcp-concurrent": true,
      profile: { "store-selected": false, "store-fake-ip": false },
      proxies: [], listeners: [], rules: ["MATCH,DIRECT"],
    })
    await reloadConfig(PROBE_API, "zcode-probe", CONFIG_IN_CONTAINER, { log: () => {}, baseDir: cfg.baseDir })
    await sleep(1500)
    return true
  } catch { return false }
}

const PROBE_BATCH = 181
// 一批最多探 PROBE_BATCH 个候选。要的出口多（多出口、重新挑选）而一批不够时，
// 换下一批没探过的节点继续，直到凑够或候选用完。
export async function probePool(cfg0, ctx, { proxies, excludeNodes, excludeIps, want }) {
  const found = [], skip = new Set(excludeNodes ?? []), ips = new Set(excludeIps ?? [])
  for (let pass = 0; pass < 6 && found.length < want; pass++) {
    const got = await probeBatch(cfg0, ctx, { proxies, excludeNodes: skip, excludeIps: ips, want: want - found.length })
    for (const x of got) { found.push(x); ips.add(x.ip) }
    const tried = got.tried ?? []
    if (tried.length < PROBE_BATCH) break
    for (const node of tried) skip.add(node)
    if (found.length < want) ctx.log(`还差 ${want - found.length} 个出口，继续探下一批候选`)
  }
  return found
}
async function probeBatch(cfg0, ctx, { proxies, excludeNodes, excludeIps, want }) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const base = Number(cfg.probePortBase) || 18200
  const candidates = pickCandidates(proxies, PROBE_BATCH, excludeNodes)
  if (!candidates.length) { ctx.log("候选池为空"); return [] }
  ctx.log(`探候选 ${candidates.length} 个（跨 /24 轮询）`)

  await resetProbe(cfg)
  const listeners = candidates.map((node, i) => ({ name: `probe-${base + i}`, type: "socks", port: base + i, listen: "127.0.0.1", proxy: node, udp: false }))
  writeConfig(join(cfg.baseDir, "probe-config", "config.yaml"), {
    "mixed-port": 0, "allow-lan": false, mode: "rule", "log-level": "warning", ipv6: false,
    "external-controller": "127.0.0.1:19094", "unified-delay": true, "tcp-concurrent": true,
    profile: { "store-selected": false, "store-fake-ip": false },
    proxies: uniqProxies(proxies), listeners, rules: ["MATCH,DIRECT"],
  })
  if (!(await reloadConfig(PROBE_API, "zcode-probe", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir }))) {
    // probe 实例不在/起不来（容器被删、首次创建配置缺失等）：ensureBackend 会把两个
    // 容器一起拉起，再给一次机会——别让「补池/分配」因为探测实例缺席而整轮失败。
    ctx.log("probe 配置加载失败，拉起后端后重试…")
    try { await ensureBackend(cfg, { log: ctx.log }) } catch {}
    if (!(await reloadConfig(PROBE_API, "zcode-probe", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir }))) {
      ctx.log("probe 配置加载失败"); await resetProbe(cfg); return []
    }
  }
  await sleep(1200)

  const ports = candidates.map((_, i) => base + i)
  const infos = await mapPool(ports, PROBE_WORKERS, async (port) => {
    const ip = await exitIp(port)
    const z = await zcodeProbe(port)
    return { ip, code: z.code, tls: z.tls, total: z.total }
  })
  recordNodeTests(proxies, candidates.map((node, i) => ({ ...infos[i], node })), { source: "selection" })

  const live = []
  candidates.forEach((node, i) => {
    const info = infos[i]
    if (!info?.ip) return
    if (info.code === "405") return // 出厂就被 zcode 边缘拦，直接淘汰
    live.push({ node, ip: info.ip, tls: info.tls ?? null, total: info.total })
  })
  ctx.log(`候选可用 ${live.length}/${candidates.length}（已剔除 405）`)

  live.sort((a, b) => (a.tls ?? Infinity) - (b.tls ?? Infinity))
  const seen = new Set(excludeIps ?? [])
  const uniq = []
  for (const x of live) {
    if (seen.has(x.ip)) continue
    seen.add(x.ip)
    uniq.push(x)
    if (uniq.length >= want) break
  }
  if (uniq.length) ctx.log(`TLS 最快 ${live[0].tls == null ? "未测" : live[0].tls.toFixed(3) + "s"}；去重后 ${uniq.length} 个不同出口（目标 ${want}）`)
  await resetProbe(cfg)
  uniq.tried = candidates
  return uniq
}

// —— state ——

export const statePath = (cfg) => join(resolveBaseDir(cfg), "state.json")
export const loadState = (cfg) => readJson(statePath(cfg), null)
export const saveState = (cfg, st) => {
  writeJsonAtomic(statePath(cfg), st)
}

// —— magpie 对齐（写各供应商的 accountProxies，原子替换；热加载，不停服） ——

// 把 bindings 里受管供应商的 账号→端口 全量写进 providers.json。
// 只写白名单内的供应商；mapping 是完整目标态，账号/Key 消失时旧记录一并清掉。
export function syncAll(cfg0, { log = () => {}, dryRun = false } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const b = loadBindings()
  if (!b) return { ok: false, why: "bindings.json 不存在（还没迁移）" }
  const provs = listProviders()
  const managed = managedIds(cfg, provs)
  const detail = []
  let wrote = 0
  for (const pid of managed) {
    const info = provs.find((x) => x.id === pid)
    if (!info) continue
    // 护栏：枚举突然变空（logins.json 短暂读不到等）而旧配置还有记录时不动它，
    // 避免「完整目标态」替换把整个供应商的出口配置误清
    if (!info.accounts.length && Object.keys(info.proxies ?? {}).length) {
      log(`⚠ ${pid} 账号枚举为空但 accountProxies 有 ${Object.keys(info.proxies).length} 条，跳过对齐`)
      continue
    }
    // 多出口的账号/Key 写入口地址（一个地址后面是多个出口），其余写自己的出口端口
    const mapping = {}
    for (const [acc, bind] of Object.entries(b.bindings?.[pid] ?? {})) {
      const url = proxyUrlOf(bind)
      if (url) mapping[acc] = url
    }
    if (dryRun) { detail.push({ provider: pid, mapping }); continue }
    const r = setProviderAccountProxies(pid, mapping, { log })
    if (r.wrote) wrote++
    detail.push({ provider: pid, changed: r.changed.length, removed: r.removed.length })
  }
  if (!dryRun && wrote) log(`magpie accountProxies 已更新（${detail.map((d) => `${d.provider} 改${d.changed}/清${d.removed}`).join("；")}），热加载生效，无需重启`)
  return { ok: true, wrote, detail }
}

// 重建 mihomo 配置 + reload + 实测主端口写回 IP（assign/seed/check 共用）
// bindings 不传时读盘；调用方还没把新绑定落盘（seed / setExits）时显式传入。
async function rebuildAndVerify(cfg, st, ctx, { verifyPorts, bindings } = {}) {
  const proxies = await fetchProxies(cfg)
  writeConfig(configPath(cfg), egressConfig(cfg, st, proxies, { bindings }))
  const okReload = await reloadConfig(EGRESS_API, "zcode-egress", CONFIG_IN_CONTAINER, { log: ctx.log, baseDir: cfg.baseDir })
  if (!okReload) throw new Error("mihomo reload 失败（配置已写盘但 API 没起来，下轮体检自愈）")
  await sleep(2000)
  const ports = verifyPorts ?? Object.keys(st.assignments).map(Number).sort((a, b) => a - b)
  const res = await probePorts(ports)
  for (let i = 0; i < ports.length; i++) if (res[i]) st.assignments[String(ports[i])].ip = res[i]
  return { proxies, ports, res }
}

// —— 一键分配（固定绑定） ——

// 给待分配（binding 缺失 / port null）的账号/Key 挑新出口并钉住。
// 已有绑定一概不动；候选按 TLS 排序、出口 IP 与现有全部绑定去重。
export async function assignPending(cfg0, ctx, { provider } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  await ensureEgressApi(cfg, ctx)
  const b = loadBindings() ?? migrateBindings(cfg, ctx).bindings
  const want = pendingList(b, cfg, { provider })
  if (!want.length) return { ok: true, assigned: 0, pending: 0, why: provider ? `${provider} 没有待分配的账号/Key` : "没有待分配的账号/Key" }
  ctx.log(`一键分配：${want.length} 个待绑定（${want.map((w) => `${w.provider}/${w.label}`).slice(0, 8).join(", ")}${want.length > 8 ? " …" : ""}）`)
  return assignAccounts(cfg, ctx, b, want)
}

export async function assignAccounts(cfg0, ctx, b, want) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const st = loadState(cfg) ?? freshState()
  st.assignments ??= {}
  st.spares ??= []
  const usedPorts = takenPorts(cfg, st, b)

  const proxies = await fetchProxies(cfg)
  const got = await probePool(cfg, ctx, { proxies, excludeNodes: takenNodes(st), excludeIps: takenIps(st), want: want.length })
  if (!got.length) return { ok: false, why: "没有可用的新出口（候选池空或全被占用），稍后再试" }

  const now = Math.floor(Date.now() / 1000)
  const freshPorts = []
  for (let i = 0; i < want.length && i < got.length; i++) {
    const port = allocPort(cfg, usedPorts, st.spares.length)
    if (!port) { ctx.log("⚠ 端口段用尽，剩余账号/Key 未分配"); break }
    usedPorts.add(port)
    const { provider: pid, account, label } = want[i]
    b.bindings[pid] = b.bindings[pid] ?? {}
    b.bindings[pid][account] = { port, at: now, mode: "auto" }
    st.assignments[String(port)] = { node: got[i].node, ip: got[i].ip }
    freshPorts.push(port)
    ctx.log(`  ${pid}/${label} → :${port} ${got[i].node}（${got[i].ip}）`)
  }
  if (freshPorts.length < want.length) ctx.log(`⚠ 合格新出口只有 ${freshPorts.length} 个，还差 ${want.length - freshPorts.length} 个待下次补齐`)

  saveBindings(b)
  saveState(cfg, st)
  if (freshPorts.length) {
    try {
      await rebuildAndVerify(cfg, st, ctx, { verifyPorts: freshPorts })
    } catch (e) {
      ctx.log(`⚠ 配置重建失败：${String(e?.message ?? e).slice(0, 160)}（绑定已记录，下轮体检重试）`)
    }
    saveState(cfg, st)
    syncAll(cfg, { log: ctx.log })
  }
  ctx.log(`一键分配完成：新绑 ${freshPorts.length}/${want.length}`)
  return { ok: true, assigned: freshPorts.length, pending: want.length - freshPorts.length }
}

// —— 手动绑定 / 解绑（面板与第三方 API 共用） ——

// 绑定单个账号/Key：
//   带 node   → 新端口挂这个节点（已是绑定端口时等价换绑）；
//   不带 node → 自动挑一个去重新出口。
export async function bindAccount(cfg0, ctx, provider, account, { node } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  if (!provider || !account) return { ok: false, why: "要 provider 和 account" }
  await ensureEgressApi(cfg, ctx)
  const b = loadBindings() ?? migrateBindings(cfg, ctx).bindings
  const cur = b.bindings?.[provider]?.[account]
  if (cur?.port && node) return swapPort(cfg, ctx, cur.port, node)
  if (cur?.port && !node) return { ok: true, already: true, provider, account, port: cur.port, mode: cur.mode }
  if (node) {
    const st = loadState(cfg) ?? freshState()
    st.assignments ??= {}
    st.spares ??= []
    // 同一节点只能挂一个端口：手动绑定时若挑中了已占用的节点，直接把冲突说清楚，
    // 别写进 state（主备同名会让配置重建时 mihomo fatal，整层出口一起挂）。
    const otherMain = Object.entries(st.assignments).find(([, v]) => v?.node === node)
    if (otherMain) throw new Error(`节点 ${node} 已绑定在 :${otherMain[0]}，不能复用`)
    const spareIdx = st.spares.findIndex((s) => s?.node === node)
    if (spareIdx >= 0) {
      const sp = Number(cfg.spareBase) + spareIdx
      st.spares.splice(spareIdx, 1)
      ctx.log(`节点 ${node} 取自备用位 :${sp}，已从备用池摘除（下轮体检补回）`)
    }
    const port = allocPort(cfg, takenPorts(cfg, st, b), st.spares.length)
    if (!port) return { ok: false, why: "端口段用尽" }
    st.assignments[String(port)] = { node, ip: null }
    b.bindings[provider] = b.bindings[provider] ?? {}
    b.bindings[provider][account] = { port, at: Math.floor(Date.now() / 1000), mode: "manual" }
    saveBindings(b)
    try {
      await rebuildAndVerify(cfg, st, ctx, { verifyPorts: [port] })
    } catch (e) {
      ctx.log(`⚠ 配置重建失败：${String(e?.message ?? e).slice(0, 160)}（绑定已记录）`)
    }
    saveState(cfg, st)
    syncAll(cfg, { log: ctx.log })
    ctx.log(`bind ${provider}/${account} → :${port} ${node}`)
    return { ok: true, provider, account, port, node }
  }
  return assignAccounts(cfg, ctx, b, [{ provider, account, label: account }])
}

// 解绑：删绑定、删端口、重建配置（摘掉 listener）、对齐 magpie
export async function unbindAccount(cfg0, ctx, provider, account, { io = {} } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  if (!provider || !account) return { ok: false, why: "要 provider 和 account" }
  const rebuild = io.rebuild ?? rebuildAndVerify
  await (io.ensureApi ?? ensureEgressApi)(cfg, ctx)
  const b = loadBindings()
  const bind = b?.bindings?.[provider]?.[account]
  if (!bind) return { ok: true, removed: false, why: "本来就没有绑定" }
  const port = bind.port
  // 多出口的账号：全部出口端口一起释放，入口随绑定消失
  const ports = exitPortsOf(bind)
  delete b.bindings[provider][account]
  if (!Object.keys(b.bindings[provider]).length) delete b.bindings[provider]
  saveBindings(b)
  const st = loadState(cfg)
  const held = st ? ports.filter((p) => st.assignments?.[String(p)]) : []
  if (st && (held.length || isMultiExit(bind))) {
    for (const p of held) {
      delete st.assignments[String(p)]
      if (st.last_zcode) delete st.last_zcode[String(p)]
    }
    try {
      await rebuild(cfg, st, ctx)
    } catch (e) {
      ctx.log(`⚠ 配置重建失败：${String(e?.message ?? e).slice(0, 160)}（绑定与端口已删）`)
    }
    saveState(cfg, st)
  }
  syncAll(cfg, { log: ctx.log })
  ctx.log(`unbind ${provider}/${account}${ports.length ? `（释放 ${ports.map((p) => ":" + p).join(" ")}）` : ""}`)
  return { ok: true, removed: true, provider, account, port, ports }
}

// —— 单 Key 多出口 ——
//
// 把一个已绑定账号/Key 的出口数量调到 count（1–配置的 maxExits），可同时改分流策略。
// magpie 侧仍然只有一个代理地址：多于一个出口时指向本地入口端口，由 mihomo 的
// load-balance 组分流到各出口；回到 1 个出口时改回主出口端口。
//   增加：从候选里挑出口 IP 与现有全部出口都不同的新节点，各占一个新端口；
//   减少：从最后追加的出口开始释放，主出口永远保留；
//   候选不够：能加几个加几个，结果里 partial = true。
// 入口没验证通过就整体回滚——magpie 不会被指到一个不通的地址上。
export async function setExits(cfg0, ctx, provider, account, count, { strategy, io = {} } = {}) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const want = Number(count)
  if (!provider || !account) return { ok: false, why: "要 provider 和 account" }
  if (!Number.isInteger(want) || want < 1 || want > MAX_EXITS) return { ok: false, why: `出口数量需为 1–${exitsLimit(cfg)} 的整数` }
  if (strategy !== undefined && !LB_STRATEGIES.includes(strategy)) return { ok: false, why: `分流策略需为 ${LB_STRATEGIES.join(" / ")}` }
  const ensureApi = io.ensureApi ?? ensureEgressApi
  const source = io.proxies ?? fetchProxies
  const pool = io.pool ?? probePool
  const rebuild = io.rebuild ?? rebuildAndVerify
  const probe = io.probe ?? exitIp
  const pause = io.pause ?? sleep

  await ensureApi(cfg, ctx)
  const b = loadBindings()
  const bind = b?.bindings?.[provider]?.[account]
  if (!bind?.port) return { ok: false, why: "该账号还没有绑定出口，请先分配或绑定" }
  const st = loadState(cfg)
  if (!st?.assignments?.[String(bind.port)]) return { ok: false, why: "主出口没有分配记录，请先运行一次体检" }
  st.spares ??= []
  const before = { bind: structuredClone(bind), assignments: structuredClone(st.assignments), lastZcode: structuredClone(st.last_zcode ?? null) }
  const wasMulti = isMultiExit(bind)
  const exits = exitPortsOf(bind)
  const had = exits.length
  // 上限调低后，已有的出口保留，只是不能再加；减少始终允许。
  if (want > exitsLimit(cfg) && want > had) return { ok: false, why: `出口数量需为 1–${exitsLimit(cfg)} 的整数（上限可在设置的「体检与备用」中调整）`, have: had }
  const nextStrategy = strategy ?? (LB_STRATEGIES.includes(bind.strategy) ? bind.strategy : LB_STRATEGIES[0])
  const describe = () => exits.map((port, i) => ({ port, node: st.assignments[String(port)]?.node ?? null, ip: st.assignments[String(port)]?.ip ?? null, primary: i === 0 }))
  const label = `${provider}/${account}`

  const added = [], removed = []
  if (want < exits.length) {
    for (const port of exits.splice(want)) {
      removed.push(port)
      delete st.assignments[String(port)]
      if (st.last_zcode) delete st.last_zcode[String(port)]
    }
  } else if (want > exits.length) {
    const need = want - exits.length
    ctx.log(`多出口：${label} 需要新增 ${need} 个出口`)
    const got = await pool(cfg, ctx, { proxies: await source(cfg), excludeNodes: takenNodes(st), excludeIps: takenIps(st), want: need })
    const usedPorts = takenPorts(cfg, st, b)
    for (const candidate of got.slice(0, need)) {
      const port = allocPort(cfg, usedPorts, st.spares.length)
      if (!port) { ctx.log("⚠ 端口段用尽，剩余出口未添加"); break }
      usedPorts.add(port)
      st.assignments[String(port)] = { node: candidate.node, ip: candidate.ip ?? null }
      exits.push(port); added.push(port)
      ctx.log(`  ${label} + :${port} ${candidate.node}（${candidate.ip ?? "?"}）`)
    }
    if (!added.length) {
      st.assignments = before.assignments
      return { ok: false, why: "没有可用的新出口（候选池空、全被占用或出口 IP 重复），稍后再试", have: had }
    }
  }

  if (exits.length > 1) {
    bind.extra = exits.slice(1)
    if (!isMultiExit(bind)) {
      const front = allocPort(cfg, new Set([...takenPorts(cfg, st, b), ...exits]), st.spares.length)
      if (!front) { st.assignments = before.assignments; return { ok: false, why: "端口段用尽，无法分配入口端口" } }
      bind.front = front
    }
    bind.strategy = nextStrategy
  } else {
    delete bind.extra; delete bind.front; delete bind.strategy
  }
  if (!added.length && !removed.length && before.bind.strategy === bind.strategy && before.bind.front === bind.front) {
    return { ok: true, changed: false, provider, account, exits: describe(), front: bind.front ?? null, strategy: bind.strategy ?? null }
  }
  bind.at = Math.floor(Date.now() / 1000)

  const result = () => ({
    ok: true, changed: true, provider, account, exits: describe(), front: bind.front ?? null, strategy: bind.strategy ?? null,
    proxy: proxyUrlOf(bind), added: added.length, removed: removed.length, partial: exits.length < want,
  })
  if (wasMulti && exits.length === 1) {
    // 撤掉入口：先让 magpie 指回主出口，再摘 listener——中间没有指向空端口的窗口。
    saveBindings(b); saveState(cfg, st)
    syncAll(cfg, { log: ctx.log })
    try { await rebuild(cfg, st, ctx, { verifyPorts: [], bindings: b }) }
    catch (e) { ctx.log(`⚠ 配置重建失败：${String(e?.message ?? e).slice(0, 160)}（绑定已改回单出口，下轮体检重建）`) }
    saveState(cfg, st)
    ctx.log(`多出口：${label} 已改回单出口 :${bind.port}`)
    return result()
  }

  const rollback = async (why) => {
    st.assignments = before.assignments
    if (before.lastZcode) st.last_zcode = before.lastZcode
    try { await rebuild(cfg, st, ctx, { verifyPorts: [], bindings: loadBindings() }) }
    catch (e) { ctx.log(`⚠ 回滚时配置重建失败：${String(e?.message ?? e).slice(0, 160)}（下轮体检按原状态重建）`) }
    ctx.log(`⚠ 多出口未生效，已恢复原状：${why}`)
    return { ok: false, why, have: had }
  }
  try {
    await rebuild(cfg, st, ctx, { verifyPorts: added, bindings: b })
  } catch (e) {
    return rollback(`配置重建失败：${String(e?.message ?? e).slice(0, 160)}`)
  }
  let frontIp = await probe(bind.front)
  if (!frontIp) { await pause(1500); frontIp = await probe(bind.front) }
  if (!frontIp) return rollback(`入口 :${bind.front} 没有连通`)

  saveBindings(b); saveState(cfg, st)
  syncAll(cfg, { log: ctx.log })
  ctx.log(`多出口：${label} → 入口 :${bind.front}（${bind.strategy}）出口 ${exits.map((p) => ":" + p).join(" ")}${exits.length < want ? `；候选不足，还差 ${want - exits.length} 个` : ""}`)
  return result()
}

// —— 健康检查 ——

export async function check(cfg0, ctx, { force = false, io = {} } = {}) {
  const ensureApi = io.ensureApi ?? ensureEgressApi
  const probe = io.probe ?? probePorts
  const probeZcode = io.probeZcode ?? detailedZcodePorts
  const rebuild = io.rebuild ?? rebuildAndVerify
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  let b = loadBindings() ?? migrateBindings(cfg, ctx).bindings
  const now = () => Date.now() / 1000

  // 全新安装：还没分配过出口，也没有等待自动分配的账号，体检无事可做。
  // 不为一次空体检去下载内核、拉起后端或启动 Docker 容器。
  if (!loadState(cfg) && !(cfg.autoAssignNew !== false && pendingList(b, cfg).length)) {
    return { ok: false, idle: true, why: "没有 state.json，先跑 init/reseed" }
  }

  await ensureApi(cfg, ctx)

  // 自动分配：白名单内出现未绑定的账号/Key（新登录/新 Key）时先补齐。
  // 候选不够时同一批待分配账号 30 分钟内不再重探（每次要探上百个候选）；
  // 待分配名单一变、手动分配或强制体检都会立即重试。
  if (cfg.autoAssignNew !== false) {
    const pend = pendingList(b, cfg)
    if (pend.length) {
      const key = pend.map((x) => `${x.provider}/${x.account}`).sort().join("|")
      const hold = loadState(cfg)?.backoff?.assign
      if (!force && hold?.key === key && now() < hold.until) {
        ctx.log(`${pend.length} 个未绑定账号/Key 上次没有足够候选，${Math.ceil((hold.until - now()) / 60)} 分钟后再试（可手动分配）`)
      } else {
        ctx.log(`发现 ${pend.length} 个未绑定账号/Key，自动分配…`)
        let short = true
        try {
          const r = await assignPending(cfg, ctx)
          short = !r.ok || r.pending > 0
        } catch (e) { ctx.log(`⚠ 自动分配失败：${String(e?.message ?? e).slice(0, 160)}`) }
        const after = loadState(cfg)
        if (after) {
          after.backoff = { ...after.backoff }
          if (short) after.backoff.assign = { key, until: now() + RETRY_AFTER }
          else delete after.backoff.assign
          saveState(cfg, after)
        }
        b = loadBindings() ?? b
      }
    }
  }

  const st = loadState(cfg)
  if (!st) return { ok: false, why: "没有 state.json，先跑 init/reseed" }
  const assignments = st.assignments ?? {}
  let spares = st.spares ?? []
  let changes = false

  // 孤儿绑定清理：账号/Key 在 magpie 侧已彻底消失的，归还端口、摘掉 listener。
  // 多出口的绑定连同追加出口一起归还。
  const pruned = pruneOrphanBindings(cfg, { log: ctx.log })
  if (pruned.pruned) {
    for (const f of pruned.freed) for (const port of f.ports ?? (f.port ? [f.port] : [])) delete assignments[String(port)]
    changes = true
    b = loadBindings() ?? b
  }
  // 端口归属在自动分配和清理之后再取：本轮新绑的端口也要按所属供应商判定
  const owners = portOwners(b)
  const isZPort = (p) => owners.get(Number(p))?.provider === "zcode"

  // 归一化：备用池里不许出现正在当主出口的节点（同名会写出重名配置，mihomo 拒载）
  const norm = dedupeSpares({ assignments, spares })
  if (norm.dropped) {
    ctx.log(`⚠ 备用池摘掉 ${norm.dropped} 个与主出口撞名的节点：${norm.droppedNodes.filter(Boolean).join(", ")}`)
    spares = norm.spares
    st.spares = spares
    changes = true
  }

  const mainPorts = Object.keys(assignments).map(Number).sort((a, b) => a - b)
  const sparePorts = spares.map((_, i) => Number(cfg.spareBase) + i)
  const allPorts = [...mainPorts, ...sparePorts]

  ctx.log(`检查 ${mainPorts.length} 主 + ${sparePorts.length} 备`)
  const ips = await probe(allPorts)
  const probedNodes = new Map(mainPorts.map((p) => [p, assignments[String(p)].node]))

  // 全灭保护：所有主出口都探不到 IP，多半是 mihomo 本身没起来（而非节点全死），
  // 这时换节点毫无意义还可能把好节点换光——告警并跳过本轮。
  if (mainPorts.length && ips.slice(0, mainPorts.length).every((x) => !x)) {
    ctx.log("⚠ 所有主出口都无响应，疑似 mihomo 未运行，本轮不判死、不换节点")
    st.last_check = {
      ts: Date.now() / 1000, error: "所有主出口无响应，请检查 mihomo 服务",
      ports: Object.fromEntries(mainPorts.map((p) => [String(p), { node: assignments[String(p)].node, ip: null, zcode: "skip" }])),
    }
    saveState(cfg, st)
    return { ok: false, why: "mihomo 无响应（全部主出口探不到 IP）" }
  }

  for (let i = 0; i < mainPorts.length; i++) assignments[String(mainPorts[i])].ip = ips[i] ?? null
  for (let i = 0; i < spares.length; i++) spares[i].ip = ips[mainPorts.length + i] ?? null

  // zcode 端点探测降频（默认 1h），force 或到期才跑；只对 zcode 绑定的端口有意义，
  // 其它供应商的出口只看出口 IP（405 是 zcode 边缘的态度，不代表别的服务不可用）
  const lastZc = st.last_zcode_ts ?? 0
  let zc
  if (force || Date.now() / 1000 - lastZc >= ZCODE_INTERVAL) {
    const details = await probeZcode(allPorts)
    zc = details.map((result) => typeof result === "string" ? result : result?.code ?? "000")
    const probedNames = [...mainPorts.map((port) => probedNodes.get(port)), ...spares.map((spare) => spare.node)]
    const measured = details.flatMap((result, i) => result && typeof result === "object" ? [{ ...result, node: probedNames[i], ip: ips[i] }] : [])
    if (measured.length) recordNodeTests(cachedProxies(cfg), measured, { source: "health" })
    st.last_zcode_ts = Date.now() / 1000
    // 持久化最近一次真实探测结果：体检不重跑探测时沿用，面板不再退回「未测」。
    // 405 不入表——被判死的端口同轮已换新节点，沿用旧 405 会把新节点再误判死。
    st.last_zcode = Object.fromEntries(allPorts.map((p, i) => [String(p), zc[i] === "405" ? "skip" : zc[i]]))
    ctx.log("zcode 端点探测：" + mainPorts.filter(isZPort).map((p) => `${p}:${zc[mainPorts.indexOf(p)]}`).join(" "))
  } else {
    zc = allPorts.map((p) => st.last_zcode?.[String(p)] ?? "skip")
    ctx.log(`zcode 探测未到周期（剩 ${Math.ceil(ZCODE_INTERVAL - (Date.now() / 1000 - lastZc))}s），沿用上次结果`)
  }

  const dead = []
  for (let i = 0; i < mainPorts.length; i++) {
    const p = mainPorts[i]
    const ip = ips[i]
    const code = zc[i]
    if (!ip) dead.push({ port: p, why: "no-exit" })
    else if (code === "405" && isZPort(p)) dead.push({ port: p, why: "zcode-405" })
    else if (code === "000" && isZPort(p)) ctx.log(`⚠ ${p} zcode 探测超时（暂不判死）`)
  }
  // 出口 IP 冲突也要处理（两个绑定共用同一出口 = 白配，不分供应商）
  const ipOwner = new Map()
  for (let i = 0; i < mainPorts.length; i++) {
    const p = mainPorts[i]
    const ip = ips[i]
    if (!ip) continue
    if (ipOwner.has(ip)) {
      ctx.log(`DUP-IP: ${p} 与 ${ipOwner.get(ip)} 同为 ${ip}`)
      if (!dead.some((d) => d.port === p)) dead.push({ port: p, why: "dup-ip" })
    } else ipOwner.set(ip, p)
  }
  for (const d of dead) ctx.log(`DEAD(${d.why}): ${d.port} → ${assignments[String(d.port)]?.node}`)

  if (dead.length) {
    const healthySpares = []
    const occupiedIps = new Set(mainPorts.filter((p) => !dead.some((d) => d.port === p)).map((p) => assignments[String(p)].ip).filter(Boolean))
    for (let i = 0; i < spares.length; i++) {
      const p = sparePorts[i]
      const ip = ips[mainPorts.length + i]
      if (ip && zc[mainPorts.length + i] !== "405" && !occupiedIps.has(ip)) {
        healthySpares.push({ ...spares[i], ip })
        occupiedIps.add(ip)
      }
    }
    ctx.log(`可用备用 ${healthySpares.length} 个，待修 ${dead.length} 个`)
    const usedSpares = new Set()
    for (const d of dead) {
      const cand = healthySpares.find((s) => !usedSpares.has(s.node))
      if (!cand) { ctx.log(`  端口 ${d.port} 无备用可用，保持原节点`); continue }
      usedSpares.add(cand.node)
      ctx.log(`  SWAP ${d.port}: ${assignments[String(d.port)]?.node}(${assignments[String(d.port)]?.ip}) → ${cand.node}(${cand.ip})`)
      assignments[String(d.port)] = { node: cand.node, ip: cand.ip }
      changes = true
    }
    const newSpares = healthySpares.filter((s) => !usedSpares.has(s.node))
    if (JSON.stringify(newSpares) !== JSON.stringify(spares)) { spares = newSpares; changes = true }
  } else {
    // 主出口都健康时也要淘汰坏掉的备用：连续 3 轮探不到出口就摘掉，由下面的补池换新。
    // 以前坏备用只在主出口故障那一轮才清，平时一直占着位置，真要用时备用池是空的。
    // 至少有一个端口有响应才计数——全部无响应多半是 mihomo 自己的问题，不是节点。
    const anyAlive = ips.some(Boolean)
    const kept = []
    spares.forEach((spare, i) => {
      if (ips[mainPorts.length + i]) { delete spare.miss; kept.push(spare); return }
      if (!anyAlive) { kept.push(spare); return }
      spare.miss = (spare.miss ?? 0) + 1
      if (spare.miss < SPARE_MISS_LIMIT) kept.push(spare)
      else ctx.log(`备用 :${sparePorts[i]} ${spare.node} 连续 ${spare.miss} 轮无响应，摘除`)
    })
    if (kept.length !== spares.length) { spares = kept; changes = true }
  }

  // 备用不足就补（只在缺的时候拉订阅，避免频繁换 IP）。候选不够补满时 30 分钟内
  // 不再重探：每次补池要探上百个候选，没有新节点时反复探只是白耗流量。
  const need = (Number(cfg.sparesCount) || 8) - spares.length
  const refillHold = st.backoff?.spares
  if (need > 0 && !force && refillHold && now() < refillHold) {
    ctx.log(`备用池缺 ${need} 个，上次候选不足，${Math.ceil((refillHold - now()) / 60)} 分钟后再补`)
  } else if (need > 0) {
    ctx.log(`备用池缺 ${need} 个，补充候选`)
    try {
      const proxies = await fetchProxies(cfg)
      const got = await probePool(cfg, ctx, { proxies, excludeNodes: takenNodes({ assignments, spares }), excludeIps: takenIps({ assignments, spares }), want: need })
      spares.push(...got)
      if (got.length) changes = true
      st.backoff = { ...st.backoff }
      if (got.length < need) st.backoff.spares = now() + RETRY_AFTER
      else delete st.backoff.spares
      ctx.log(`补充后备用池 ${spares.length} 个`)
    } catch (e) {
      ctx.log(`补池失败：${String(e?.message ?? e).slice(0, 160)}`)
    }
  } else if (st.backoff?.spares) delete st.backoff.spares

  st.assignments = assignments
  st.spares = spares
  if (changes) {
    try {
      await rebuild(cfg, st, ctx)
    } catch (e) {
      ctx.log(`⚠ 拿不到订阅/重建失败：${String(e?.message ?? e).slice(0, 160)}`)
    }
  } else {
    ctx.log("无需变更")
  }

  const okCount = mainPorts.filter((p) => assignments[String(p)]?.ip).length
  st.assignments = assignments
  st.spares = spares
  st.last_check = {
    ts: Date.now() / 1000,
    ports: Object.fromEntries(mainPorts.map((p, i) => {
      const current = assignments[String(p)]
      const changedNode = current?.node !== probedNodes.get(p)
      if (changedNode && st.last_zcode) delete st.last_zcode[String(p)]
      return [String(p), { node: current?.node, ip: current?.ip ?? null, zcode: changedNode ? "skip" : zc[i] ?? null }]
    })),
  }
  saveState(cfg, st)

  try {
    syncAll(cfg, { log: ctx.log })
  } catch (e) {
    // providers.json 暂时读不到等：检查与换绑成果已落 state，别让对齐失败把整轮判为失败
    ctx.log(`⚠ magpie 对齐失败（下轮重试）：${String(e?.message ?? e).slice(0, 160)}`)
  }
  ctx.log(`check 完成：${okCount}/${mainPorts.length} 主出口健康，备用 ${spares.length}，变更 ${changes ? "是" : "否"}`)
  return { ok: true, okCount, total: mainPorts.length, spares: spares.length, changes }
}

// —— init / reseed（全部受管账号重挑出口，会换 IP） ——

export async function seed(cfg0, ctx) {
  const cfg = { ...cfg0, baseDir: resolveBaseDir(cfg0) }
  const st0 = loadState(cfg)
  const b = loadBindings() ?? migrateBindings(cfg, ctx).bindings
  const provs = listProviders()
  const managed = managedIds(cfg, provs)
  const targets = []
  for (const pid of managed) {
    const p = provs.find((x) => x.id === pid)
    if (!p) continue
    for (const a of p.accounts) targets.push({ provider: pid, account: a.id, label: a.label })
  }
  if (!targets.length) return { ok: false, why: "没有受管账号，请先在设置中选择供应商" }
  await ensureEgressApi(cfg, ctx)
  // 多出口的账号/Key 重挑后保持原来的出口数量和分流策略
  const wantExits = (t) => Math.min(MAX_EXITS, Math.max(1, exitPortsOf(b?.bindings?.[t.provider]?.[t.account]).length))
  const nAccounts = targets.length
  const nExtra = targets.reduce((sum, t) => sum + wantExits(t) - 1, 0)
  const nSpares = Number(cfg.sparesCount) || 8
  const total = nAccounts + nExtra + nSpares
  ctx.log(`目标 ${nAccounts} 主${nExtra ? ` + ${nExtra} 追加出口` : ""}（${[...new Set(targets.map((t) => t.provider))].join(", ")}）+ ${nSpares} 备`)
  const proxies = await fetchProxies(cfg)
  ctx.log(`订阅节点 ${proxies.length}`)
  const got = await probePool(cfg, ctx, { proxies, excludeNodes: new Set(), excludeIps: new Set(), want: total })
  if (got.length < nAccounts) {
    ctx.log(`ERROR: 合格出口只有 ${got.length} 个，不足 ${nAccounts}`)
    return { ok: false, why: `合格出口不足（${got.length}/${nAccounts}）` }
  }

  const assignments = {}
  const bindings = {}
  const usedPorts = new Set()
  const now = Math.floor(Date.now() / 1000)
  const take = () => {
    const port = allocPort(cfg, usedPorts, nSpares)
    if (port) usedPorts.add(port)
    return port
  }
  // 先保证每个账号都有主出口，再按余量补追加出口，最后才是备用池
  let next = 0
  for (const t of targets) {
    const port = take()
    if (!port) { ctx.log("ERROR: 端口段用尽"); return { ok: false, why: "端口段用尽" } }
    assignments[String(port)] = { node: got[next].node, ip: got[next].ip }
    next++
    bindings[t.provider] = bindings[t.provider] ?? {}
    bindings[t.provider][t.account] = { port, at: now, mode: "auto" }
  }
  for (const t of targets) {
    const bind = bindings[t.provider][t.account], extra = []
    for (let i = 1; i < wantExits(t) && next < got.length; i++) {
      const port = take()
      if (!port) break
      assignments[String(port)] = { node: got[next].node, ip: got[next].ip }
      next++
      extra.push(port)
    }
    const front = extra.length ? take() : null
    if (!front) { for (const port of extra) delete assignments[String(port)]; if (extra.length) ctx.log(`⚠ 端口段用尽，${t.provider}/${t.label} 退回单出口`); continue }
    const old = b?.bindings?.[t.provider]?.[t.account]
    Object.assign(bind, { extra, front, strategy: LB_STRATEGIES.includes(old?.strategy) ? old.strategy : LB_STRATEGIES[0] })
    if (extra.length + 1 < wantExits(t)) ctx.log(`⚠ 候选不足，${t.provider}/${t.label} 只配到 ${extra.length + 1}/${wantExits(t)} 个出口`)
  }
  const spares = got.slice(next, next + nSpares)
  const saved = { ...(b ?? {}), version: 1, at: now, bindings }

  const st = {
    ...(st0 ?? {}),
    assignments, spares, withGroups: true,
    created: st0?.created ?? Date.now() / 1000,
    last_reseed: Date.now() / 1000,
    last_zcode: {}, last_zcode_ts: 0,
  }
  delete st.backoff
  await rebuildAndVerify(cfg, st, ctx, { verifyPorts: Object.keys(assignments).map(Number), bindings: saved })

  const ports = Object.keys(assignments).map(Number)
  ctx.log(`验证 ${ports.length} 个正式端口`)
  for (const p of ports) ctx.log(`  ${p} → ${assignments[String(p)].node} → ${assignments[String(p)].ip ?? "FAIL"}`)

  st.last_check = { ts: Date.now() / 1000, ports: Object.fromEntries(ports.map((p) => [String(p), { node: assignments[String(p)].node, ip: assignments[String(p)].ip ?? null, zcode: "?" }])) }
  saveState(cfg, st)
  saveBindings(saved)
  const sync = syncAll(cfg, { log: ctx.log })
  ctx.log("seed 完成")
  return { ok: true, assignments, spares, sync }
}
