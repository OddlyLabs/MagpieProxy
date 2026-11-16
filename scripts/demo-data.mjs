// Deliberately fictional fixtures. The preview never reads plugin or magpie data.
export function demoSnapshot(scenario = "normal") {
  const now = Date.now()
  const nodes = Array.from({ length: 64 }, (_, i) => ({
    name: `${["HK-HongKong", "JP-Tokyo", "SG-Singapore", "US-LosAngeles"][i % 4]}-${String(Math.floor(i / 4) + 1).padStart(2, "0")}`,
    src: i < 56 ? "sub" : "pool", ...(i < 56 ? { subscriptionId: i < 32 ? "sub-harbor" : "sub-orbit" } : {}),
    type: ["ss", "trojan", "vmess", "socks5"][i % 4], server: `192.0.2.${i + 1}`, port: 443, fingerprint: `demo-node-${i}`,
    test: i >= 48 || i % 9 === 0 ? null : {
      fingerprint: `demo-node-${i}`, checkedAt: now - (i === 10 ? 7_200_000 : (i + 1) * 35_000), source: i < 12 ? "health" : "selection",
      target: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", ip: i % 13 === 0 ? null : `203.0.113.${i + 1}`,
      code: i % 13 === 0 ? "000" : i % 11 === 0 ? "405" : "401", tlsMs: i % 13 === 0 ? null : 95 + i * 9, totalMs: i % 13 === 0 ? null : 180 + i * 11,
      status: i % 13 === 0 ? "failed" : i % 11 === 0 ? "blocked" : "reachable",
    },
  }))
  const accounts = (count, offset, login) => Array.from({ length: count }, (_, index) => {
    const i = index + offset, port = 17901 + i
    return { id: login ? `alex+${index + 1}@example.com` : `demo-key-${index + 1}`, label: login ? `alex+${index + 1}@example.com` : `sk-demo…${String(index + 1).padStart(4, "0")}`, alias: login ? `工作账号 ${String(index + 1).padStart(2, "0")}` : "", plan: login ? "ZCode" : "API Key", on: true, lapsed: false, port, node: nodes[i % nodes.length].name, ip: i < 244 ? `198.51.100.${i + 11}` : `198.18.${Math.floor((i - 244) / 254)}.${(i - 244) % 254 + 1}`, proxy: `socks5://127.0.0.1:${port}`, proxySet: true, proxyMismatch: false, hasJwt: login ? true : null, zcode: login ? "401" : null, mode: "auto", claimsToday: login && i < 4 ? 1 : 0, lastChecked: now - 180_000 }
  })
  const providers = [{ id: "zcode", name: "ZCode", kind: "login", managed: true, accounts: accounts(8, 0, true) }, { id: "atlas", name: "Atlas API", kind: "keys", managed: true, accounts: accounts(4, 8, false) }]
  providers[0].accounts[5].hasJwt = false
  providers[0].accounts[6].ip = null
  Object.assign(providers[1].accounts[3], { port: null, node: null, ip: null, proxy: null, proxySet: false, mode: "pending" })
  const all = providers.flatMap((p) => p.accounts)
  const snapshot = {
    updated: scenario === "stale" ? now - 360_000 : now, port: 3468, task: null,
    config: { checkIntervalMin: 10, sparesCount: 8, claimEnabled: true, claimHour: 19, claimMinute: 0, claimIntervalMin: 10, claimWindowHours: 6, autoAssignNew: true, managedProviders: ["zcode", "atlas"], mirror: "", backend: "auto", requestResults: [] },
    version: { plugin: "0.6.1", app: "3.17.2" },
    onboard: { hasState: true, stateWithGroups: true, accounts: 12, accountsBound: 11, pending: 1, managed: ["zcode", "atlas"], baseDir: "~/.local/share/magpie-zcode-egress/egress" },
    egress: { hasState: true, withGroups: true, lastCheck: now - 180_000, lastZcode: now - 180_000, assignments: Object.fromEntries(all.filter((a) => a.port).map((a) => [a.port, { node: a.node, ip: a.ip }])), spares: nodes.slice(16, 24).map((n, i) => ({ port: 17931 + i, node: n.name, ip: `203.0.113.${i + 31}` })) },
    sources: { subscriptions: [{ id: "sub-harbor", url: "https://harbor.example/subscribe?token=demo", count: 32, fetchedAt: now - 3_600_000, error: "" }, { id: "sub-orbit", url: "https://orbit.example/subscribe?token=demo", count: 24, fetchedAt: now - 7_200_000, error: "" }], sub: { count: 56 }, pool: { count: 8, addedAt: now - 86_400_000 }, total: 64 },
    nodes, claims: { enabled: true, inWindow: false, nextWindowAt: now + 7_200_000, today: 4, lastResult: { claimed: 4, done: 0, failed: 0, captcha: 0, skipped: 1 } },
    check: { lastAt: now - 180_000, lastResult: { code: 0 } },
    records: Array.from({ length: 18 }, (_, i) => ({ time: new Date(now - i * 480_000).toISOString(), email: `alex+${i % 8 + 1}@example.com`, account: `工作账号 ${String(i % 8 + 1).padStart(2, "0")}`, status: ["claimed", "claimed", "done", "failed", "inactive", "skipped"][i % 6], plan: `demo-plan-${i}`, planName: i % 2 ? "每日赠送 Token" : "周末赠送 Token", code: i % 6 === 3 ? 500 : 0, reason: i % 6 === 3 ? "连接暂时超时，请在下一轮重试" : i % 6 === 5 ? "账号尚未绑定出口" : "" })),
  }
  if (scenario === "empty") {
    snapshot.sources = { subscriptions: [], sub: {}, pool: {}, total: 0 }; snapshot.nodes = []; snapshot.egress = { hasState: false, assignments: {}, spares: [] }
    snapshot.providers = providers.map((p) => ({ ...p, managed: false, accounts: p.accounts.map((a) => ({ ...a, port: null, node: null, ip: null })) }))
    snapshot.onboard = { ...snapshot.onboard, hasState: false, accounts: 0, pending: 0, managed: [] }; snapshot.config.managedProviders = []
  } else snapshot.providers = providers
  if (scenario === "error") {
    snapshot.sources.subscriptions[1].error = "订阅暂时无法连接（HTTP 503），请稍后重试"
    snapshot.egress.error = "所有主出口无响应，请检查 mihomo 服务"
    for (const p of providers) for (const a of p.accounts) if (a.port) a.ip = null
  }
  if (scenario === "large") {
    providers[0].accounts = accounts(1000, 0, true)
    snapshot.egress.assignments = Object.fromEntries(providers.flatMap((p) => p.accounts).filter((a) => a.port).map((a) => [a.port, { node: a.node, ip: a.ip }]))
  }
  if (scenario === "providers") {
    for (let i = 0; i < 16; i++) providers.push({ id: `demo-provider-${i + 1}`, name: `示例供应商 ${String(i + 1).padStart(2, "0")}`, kind: i % 2 ? "keys" : "login", managed: true, accounts: accounts(60 + i, (i + 1) * 100, i % 2 === 0) })
    snapshot.config.managedProviders = providers.map((provider) => provider.id)
    snapshot.egress.assignments = Object.fromEntries(providers.flatMap((provider) => provider.accounts).filter((account) => account.port).map((account) => [account.port, { node: account.node, ip: account.ip }]))
  }
  if (scenario === "exits") {
    // 单 Key 多出口：Atlas 的第一个 Key 挂 3 个出口，其中一个暂时探测不到 IP。
    const account = providers[1].accounts[0], extra = [[17961, nodes[40], "198.51.100.201"], [17962, nodes[41], null]]
    account.exits = [{ port: account.port, node: account.node, ip: account.ip, zcode: null, primary: true }, ...extra.map(([port, node, ip]) => ({ port, node: node.name, ip, zcode: null, primary: false }))]
    Object.assign(account, { front: 17990, strategy: "round-robin", proxy: "socks5://127.0.0.1:17990" })
    for (const [port, node, ip] of extra) snapshot.egress.assignments[port] = { node: node.name, ip }
  }
  return snapshot
}
