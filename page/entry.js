(() => {
  const status = document.getElementById("entry-status")
  let target = "", action = null, navigating = false
  window.magpie?.onAction?.((event) => {
    if (event?.id === "open-egress") action = { id: event.id, provider: { id: String(event.provider?.id || "").slice(0, 160) } }
  })
  const open = () => {
    if (!target) { location.reload(); return }
    if (navigating) return
    navigating = true
    location.replace(target + (action ? "#action=" + encodeURIComponent(JSON.stringify(action)) : ""))
  }
  document.getElementById("entry-open").onclick = open
  ;(async () => {
    try {
      if (!window.magpie) throw new Error("请从 magpie 中打开，或运行 Open.cmd")
      await Promise.race([window.magpie.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("magpie 页面桥接未响应，请刷新后重试")), 10000))])
      const options = await window.magpie.options.get()
      const port = Number(options?.port || 3468)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("插件 port 选项无效，请运行 Diagnose.cmd")
      target = window.magpie.service || `http://127.0.0.1:${port}/`
      if (!target.endsWith("/")) target += "/"
      // The host sends a provider-menu action after the initial hello. Let that
      // message arrive before the service document takes over this same frame.
      setTimeout(open, 120)
    } catch (error) { status.textContent = error.message }
  })()
})()
