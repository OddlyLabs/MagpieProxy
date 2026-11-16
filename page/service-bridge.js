// The service document uses HTTP directly. Only theme, visibility and menu
// actions cross Magpie's documented postMessage bridge; actions never reload it.
(() => {
  const token = document.querySelector('meta[name="egress-session"]')?.content || ""
  const routes = { check: "check", seed: "seed", sync: "sync", claims: "claims/run", subscribe: "subscribe", "subscription-remove": "subscribe/remove", "pool-import": "pool/import", "pool-clear": "pool/clear", "probe-nodes": "nodes/probe", swap: "swap", assign: "assign", bind: "bind", unbind: "unbind", exits: "exits", config: "config", "page-seen": "page-seen" }
  async function api(path, body, timeout = 15000) {
    const response = await fetch(new URL("api/" + path, location.href), {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Egress-Token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
    })
    const value = await response.json()
    if (!response.ok || value.ok === false) throw new Error(value.error || value.message || `HTTP ${response.status}`)
    return value
  }
  const actions = [], visibility = [], themes = []
  let acting = null, readyResolve
  function paint(theme) {
    if (!theme || typeof theme.dark !== "boolean") return
    bridge.theme = theme; document.documentElement.dataset.theme = theme.dark ? "dark" : "light"
    for (const [key, value] of Object.entries(theme.tokens || {})) if (/^[\w-]+$/.test(key) && typeof value === "string") document.documentElement.style.setProperty("--magpie-" + key, value)
    for (const fn of themes) fn(theme)
  }
  const bridge = window.magpie = {
    theme: { dark: matchMedia("(prefers-color-scheme: dark)").matches }, visible: true,
    ready: new Promise((resolve) => { readyResolve = resolve }),
    onTheme(fn) { themes.push(fn) }, onVisibility(fn) { visibility.push(fn) },
    onAction(fn) { acting = fn; for (const event of actions.splice(0)) fn(event) },
    options: {
      get: () => api("ui-preferences"),
      async set({ request, pagePreferences } = {}) {
        if (pagePreferences) await api("ui-preferences", pagePreferences)
        if (!request) return {}
        const route = routes[request.action]
        if (!route) throw new Error("未知操作")
        return api(route, { ...(request.patch || {}), id: request.id }, 65 * 60_000)
      },
    },
  }
  window.EgressService = {
    async readSnapshot() {
      const status = await api("status")
      if (status.service !== "magpie-zcode-egress") throw new Error("此端口运行的不是出口管家")
      return { port: status.port, updated: status.snapshot?.updated || 0, snapshot: status.snapshot }
    },
  }
  const act = (event) => { if (acting) acting(event); else actions.push(event) }
  try { if (location.hash.startsWith("#action=")) act(JSON.parse(decodeURIComponent(location.hash.slice(8)))) } catch {}
  const hello = "egress-service-" + Math.random().toString(36).slice(2)
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.magpie !== 1) return
    const message = event.data
    if (message.id === hello && message.result) { paint(message.result); readyResolve(); return }
    if (message.event === "theme") paint(message.data)
    if (message.event === "action") act(message.data)
    if (message.event === "visibility") { bridge.visible = !!message.data?.visible; for (const fn of visibility) fn(bridge.visible) }
  })
  paint(bridge.theme)
  if (parent !== window) { parent.postMessage({ magpie: 1, id: hello, method: "hello" }, "*"); setTimeout(readyResolve, 2000) }
  else readyResolve()
})()
