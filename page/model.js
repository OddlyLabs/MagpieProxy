// Shared, DOM-free view logic. Classic scripts keep compatibility with magpie's sandbox.
globalThis.EgressUI = (() => {
  const pad = (n) => String(n).padStart(2, "0")
  const beijing = (time) => {
    const value = typeof time === "string" ? new Date(time).getTime() : Number(time)
    if (!time || !Number.isFinite(value)) return null
    const d = new Date(value + 8 * 3600_000)
    return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }
  }
  const when = (time) => {
    const d = beijing(time)
    return d ? `${d.day === beijing(Date.now()).day ? "" : d.day.slice(5).replace("-", "/") + " "}${d.time}` : "尚无记录"
  }
  const age = (time, now = Date.now()) => {
    const seconds = Math.max(0, Math.floor((now - Number(time)) / 1000))
    return seconds < 60 ? "刚刚" : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 86400)} 天前`
  }
  // 多出口账号的全部出口；单出口账号返回空数组。
  const exitsOf = (a) => Array.isArray(a?.exits) && a.exits.length > 1 ? a.exits : []
  const STRATEGY_LABELS = { "round-robin": "轮询（每条新连接换一个出口）", "sticky-sessions": "会话保持（同一目标短时间内固定出口）", "consistent-hashing": "一致性哈希（同一目标始终固定出口）" }
  const accountState = (a) => {
    if (!a.port) return { key: "pending", tone: "warn", label: "待分配", detail: "尚未绑定出口，可自动分配一个独立出口" }
    const exits = exitsOf(a), down = exits.filter((exit) => !exit.ip).length
    // 多出口：只要还有出口在线，入口就能用；坏掉的那几个由分流自动绕开。
    if (exits.length && down && down < exits.length) return { key: "degraded", tone: "warn", label: "部分出口异常", detail: `${exits.length} 个出口中有 ${down} 个未探测到出口 IP，流量已自动绕开，体检会尝试更换备用节点` }
    if (exits.length ? down === exits.length : !a.ip) return { key: "offline", tone: "bad", label: "出口异常", detail: "最近一次探测未能获取出口 IP，请运行体检" }
    if (a.zcode === "405") return { key: "blocked", tone: "bad", label: "访问被拦", detail: "ZCode 拦截了此出口，体检会尝试更换备用节点" }
    if (a.hasJwt === false || a.lapsed) return { key: "login", tone: "warn", label: "需重新登录", detail: "请在供应商页面重新登录此账号" }
    if (a.on === false) return { key: "disabled", tone: "muted", label: "已停用", detail: "此账号在供应商中已停用" }
    if (a.proxyMismatch) return { key: "unsynced", tone: "warn", label: "待同步", detail: "magpie 的代理配置与绑定不一致，可在设置中同步" }
    if (a.zcode === "000") return { key: "timeout", tone: "warn", label: "探测超时", detail: "出口可用，但 ZCode 探测超时，下一轮体检会重试" }
    return { key: "healthy", tone: "ok", label: "运行正常", detail: exits.length ? `${exits.length} 个出口均已获取出口 IP` : a.zcode === "401" ? "出口可用，ZCode API 可达" : "已获取出口 IP" }
  }
  const needsAttention = (a) => ["warn", "bad"].includes(accountState(a).tone)
  const matchesAccount = (a, provider, query = "", filter = "all") => {
    if (filter === "attention" && !needsAttention(a)) return false
    if (filter === "pending" && a.port) return false
    if (filter === "healthy" && accountState(a).key !== "healthy") return false
    const haystack = [a.label, a.alias, a.id, a.node, a.ip, a.port, a.front, ...exitsOf(a).flatMap((exit) => [exit.node, exit.ip, exit.port]), provider.name, provider.id].join(" ").normalize("NFKC").toLowerCase()
    return query.normalize("NFKC").toLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word))
  }
  const totals = (snapshot) => {
    const providers = (snapshot?.providers ?? []).filter((p) => p.managed)
    const accounts = providers.flatMap((p) => p.accounts)
    return { providers, accounts, total: accounts.length, healthy: accounts.filter((a) => accountState(a).key === "healthy").length, attention: accounts.filter(needsAttention).length, pending: accounts.filter((a) => !a.port).length }
  }
  // 本机应用该用的代理地址：多出口账号是分流入口，其余是出口端口本身。
  const proxyAddress = (account) => {
    const port = Number(exitsOf(account).length && account.front ? account.front : account.port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? `socks5://127.0.0.1:${port}` : ""
  }
  const subscriptionsOf = (sources = {}) => Array.isArray(sources.subscriptions) ? sources.subscriptions : sources.sub?.url ? [sources.sub] : []
  const hostOf = (url) => { try { return new URL(url).host } catch { return "未命名订阅" } }
  const regionOf = (name) => {
    for (const [region, pattern] of [["HK", /香港|🇭🇰/], ["TW", /台湾|台灣|🇹🇼/], ["JP", /日本|东京|大阪|🇯🇵/], ["SG", /新加坡|狮城|🇸🇬/], ["US", /美国|美國|🇺🇸/], ["KR", /韩国|韓國|🇰🇷/], ["GB", /英国|英國|🇬🇧/], ["DE", /德国|德國|🇩🇪/]]) if (pattern.test(name)) return region
    return (/^([A-Za-z]{2,3})[-_ ]/.exec(name)?.[1] ?? "").toUpperCase()
  }
  const nodeTestState = (node, now = Date.now()) => {
    const test = node?.test
    if (!test?.checkedAt) return { label: "未测试", tone: "muted", stale: false, measured: false, latency: "—", tlsMs: null, totalMs: null }
    const stale = now - test.checkedAt > 60 * 60_000
    const labels = { reachable: ["目标可达", "ok"], blocked: ["访问被拦", "bad"], failed: ["探测失败", "bad"], "tls-only": ["TLS 已连接", "warn"], "ip-only": ["仅 IP 可达", "warn"] }
    const [label, tone] = labels[test.status] || ["状态未知", "muted"]
    const tlsMs = typeof test.tlsMs === "number" && Number.isFinite(test.tlsMs) && test.tlsMs >= 0 ? test.tlsMs : null
    const totalMs = typeof test.totalMs === "number" && Number.isFinite(test.totalMs) && test.totalMs >= 0 ? test.totalMs : null
    return { label: stale ? "历史结果" : label, detail: label, tone: stale ? "muted" : tone, stale, measured: true, latency: tlsMs === null ? "未测得" : `${tlsMs.toLocaleString()} ms`, tlsMs, totalMs }
  }
  const sortNodes = (nodes, { order = "recommended", occupied = new Set(), spares = new Set(), now = Date.now() } = {}) => {
    const rank = (node) => {
      const state = nodeTestState(node, now)
      if (state.measured && !state.stale && node.test.status === "reachable") return 0
      if (state.measured && !state.stale && ["failed", "blocked"].includes(node.test.status)) return 4
      return spares.has(node.name) ? 1 : !state.measured ? 2 : 3
    }
    const delay = (node) => { const state = nodeTestState(node, now); return state.tlsMs === null ? Infinity : state.tlsMs + (state.stale ? 1e9 : 0) }
    return [...nodes].sort((a, b) => {
      const name = () => a.name.localeCompare(b.name, "zh-CN", { numeric: true })
      if (order === "name") return name()
      if (order === "latency") return delay(a) - delay(b) || name()
      return Number(occupied.has(a.name)) - Number(occupied.has(b.name)) || rank(a) - rank(b) || delay(a) - delay(b) || name()
    })
  }
  const snapshotKey = (snap) => {
    if (!snap) return ""
    const { updated, lastPageSeen, config = {}, ...data } = snap
    const { lastRequest, lastRequestResult, requestResults, ...settings } = config
    return JSON.stringify({ ...data, config: settings })
  }
  const navigationModel = (snapshot, view) => {
    const stats = totals(snapshot)
    const items = [
      { id: "egress", title: "全部账号", icon: "logo", count: stats.total, group: "工作台" },
      { id: "sources", title: "节点来源", icon: "cloud", count: snapshot.sources?.total || 0, group: "工作台" },
    ]
    if (stats.providers.some((provider) => provider.id === "zcode")) items.push({ id: "claims", title: "自动领取", icon: "clock", group: "工作台" })
    for (const provider of stats.providers) items.push({ id: `provider:${provider.id}`, title: provider.name, icon: provider.kind === "keys" ? "key" : "users", count: provider.accounts.length, group: "供应商" })
    const active = view.tab === "egress" && stats.providers.some((p) => p.id === view.provider) ? `provider:${view.provider}` : view.tab
    return { items, active: items.some((item) => item.id === active) ? active : "egress" }
  }
  return Object.freeze({ pad, beijing, when, age, accountState, needsAttention, matchesAccount, totals, proxyAddress, exitsOf, STRATEGY_LABELS, subscriptionsOf, hostOf, regionOf, nodeTestState, sortNodes, snapshotKey, navigationModel })
})()
