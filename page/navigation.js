// Optional host navigation protocol. A stock magpie rejects it without changing
// the page. The host extension validates the sender against its own page frame.
globalThis.EgressNavigation = (() => {
  let connected = false, unavailable = false, latest = null, sent = "", pending = null, sequence = 0
  const listeners = new Set()
  const notify = (value) => {
    if (connected === value) return
    connected = value
    for (const listener of listeners) listener(value)
  }
  const flush = async () => {
    if (unavailable || pending || !latest || window.parent === window || !window.magpie) return
    const signature = JSON.stringify(latest)
    if (signature === sent) return
    const id = `egress-navigation:${Date.now()}:${++sequence}`
    const job = { id, signature, value: latest }
    pending = job
    try { await window.magpie.ready } catch { pending = null; return }
    if (pending !== job) return
    job.timer = setTimeout(() => {
      if (pending !== job) return
      pending = null; unavailable = true; notify(false)
    }, 5000)
    window.parent.postMessage({ magpie: 1, id, method: "navigation.set", params: job.value }, "*")
  }
  addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.magpie !== 1 || !pending || event.data.id !== pending.id) return
    const job = pending
    clearTimeout(job.timer); pending = null
    if (event.data.error || event.data.result?.supported !== true) { unavailable = true; notify(false); return }
    sent = job.signature; notify(true); flush()
  })
  return Object.freeze({
    get connected() { return connected },
    update(value) { latest = value; flush() },
    onConnection(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  })
})()
