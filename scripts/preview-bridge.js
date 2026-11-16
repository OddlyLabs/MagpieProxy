// This file is served only by scripts/preview.mjs, never by the real plugin.
window.__EGRESS_PREVIEW__ = true
window.__previewRequests = []
const previewTheme = new URLSearchParams(location.search).get("theme")
if (previewTheme === "light" || previewTheme === "dark") document.documentElement.dataset.theme = previewTheme
window.magpie = { onAction(callback) { window.__previewAction = callback }, options: { set({ request }) {
  if (!request) return Promise.resolve()
  window.__previewRequests.push(request)
  const snapshot = window.__ZE__?.snapshot
  if (!snapshot) return Promise.resolve()
  if (request.action === "page-seen") { snapshot.config.lastRequest = request.id; return Promise.resolve() }
  snapshot.task = { requestId: request.id, action: request.action, startedAt: Date.now() }
  setTimeout(() => {
    const patch = request.patch || {}, providers = snapshot.providers || [], accounts = providers.flatMap((p) => p.accounts)
    const target = providers.find((p) => p.id === patch.provider)?.accounts.find((a) => a.id === patch.account)
    let message = "演示操作完成", kind = "ok"
    if (window.__previewFailNext) { message = "演示：后台暂时无法连接，请重试"; kind = "err"; window.__previewFailNext = false }
    else if (request.action === "config") {
      Object.assign(snapshot.config, patch)
      if (patch.managedProviders) for (const p of providers) p.managed = patch.managedProviders.includes(p.id)
      message = "设置已保存（演示）"
    } else if (request.action === "subscribe") {
      const urls = patch.urls || (patch.url && !patch.subscriptionId ? [patch.url] : [])
      for (const url of urls) if (!snapshot.sources.subscriptions.some((s) => s.url === url)) snapshot.sources.subscriptions.push({ id: "demo-" + Math.random().toString(36).slice(2), url, count: 8, fetchedAt: Date.now(), error: "" })
      for (const sub of snapshot.sources.subscriptions) if (!patch.subscriptionId || sub.id === patch.subscriptionId) { if (patch.subscriptionId && patch.url) sub.url = patch.url; sub.error = ""; sub.fetchedAt = Date.now() }
      if (!snapshot.nodes.length) snapshot.nodes = Array.from({ length: 8 }, (_, i) => ({ name: `HK-Demo-${i + 1}`, src: "sub" }))
      snapshot.sources.total = snapshot.nodes.length; message = "订阅已更新（演示）"
    } else if (request.action === "subscription-remove") {
      snapshot.sources.subscriptions = snapshot.sources.subscriptions.filter((s) => s.id !== patch.subscriptionId); message = "订阅已移除（演示）"
    } else if (request.action === "pool-clear") { snapshot.sources.pool.count = 0; message = "号池已清空（演示）" }
    else if (request.action === "pool-import") { snapshot.sources.pool = { count: (snapshot.sources.pool.count || 0) + patch.text.split("\n").filter(Boolean).length, addedAt: Date.now() }; snapshot.sources.total += snapshot.sources.pool.count; message = "号池已导入（演示）" }
    else if (request.action === "unbind" && target) {
      delete snapshot.egress.assignments[target.port]; Object.assign(target, { port: null, ip: null, node: null, proxySet: false, mode: "pending" }); message = "已解除绑定（演示）"
    } else if (["bind", "assign", "swap"].includes(request.action)) {
      const targets = target ? [target] : providers.filter((p) => p.managed && (!patch.provider || p.id === patch.provider)).flatMap((p) => p.accounts).filter((a) => !a.port)
      for (const account of targets) {
        const old = { node: account.node, ip: account.ip }, port = account.port || 17920 + accounts.indexOf(account)
        const node = patch.node || snapshot.nodes.find((n) => !accounts.some((a) => a.node === n.name))?.name || "HK-Demo-New"
        const spare = snapshot.egress.spares.find((s) => s.node === node)
        if (spare) Object.assign(spare, old)
        Object.assign(account, { port, node, ip: `203.0.113.${accounts.indexOf(account) + 61}`, proxySet: true, proxyMismatch: false, mode: "manual", zcode: "skip" })
        snapshot.egress.assignments[port] = { node, ip: account.ip }
      }
      snapshot.egress.hasState = snapshot.onboard.hasState = true; message = "出口绑定已更新（演示）"
    } else if (request.action === "probe-nodes") {
      for (const node of snapshot.nodes.filter((node) => patch.names.includes(node.name))) node.test = { fingerprint: node.fingerprint, checkedAt: Date.now(), source: "manual", target: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", tlsMs: 126, totalMs: 241, code: "401", status: "reachable", ip: "203.0.113.120" }
      message = `已测试 ${patch.names.length} 个节点，详情已更新（演示）`
    } else if (request.action === "check") { snapshot.egress.lastCheck = Date.now(); snapshot.egress.error = ""; message = "出口体检完成（演示）" }
    else if (request.action === "claims") { message = "领取流程已完成（演示）" }
    else if (request.action === "sync") { for (const a of accounts) a.proxyMismatch = false; message = "绑定已同步（演示）" }
    const receipt = { id: request.id, action: request.action, message, kind, ok: kind !== "err", at: Date.now() }
    snapshot.task = null; snapshot.config.lastRequest = request.id; snapshot.config.lastRequestResult = receipt
    snapshot.config.requestResults = [...(snapshot.config.requestResults || []), receipt].slice(-32)
    snapshot.updated = window.__ZE__.updated = Date.now()
  }, window.__previewDelay ?? 650)
  return Promise.resolve()
} } }
// The host preview loads the genuine bridge after this simulator. Its fixture
// service relays operations here, so every action still changes fictional data.
if (location.pathname.startsWith("/host-frame/")) {
  const simulate = window.magpie.options.set
  addEventListener("message", (event) => {
    if (event.source === parent && event.data?.egressPreview === 1) simulate({ request: event.data.request })
  })
}
