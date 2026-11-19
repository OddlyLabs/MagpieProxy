// 阿里云人机验证 attestation：隐藏有头 Chrome（无头会被 F001 拒），
// 服务器没有显示器 → 有 Xvfb 时套 xvfb-run，有 DISPLAY 时直跑。
// Chrome 的流量走账号自己的出口代理（--proxy-server），保证 attestation 与
// 领取请求同 IP。
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserCandidates, nativeDisplayReady } from "./platform.mjs"
import { killProcessTree } from "./process.mjs"

export const chromePath = () => browserCandidates().find((p) => existsSync(p)) ?? ""

const hasDisplay = () => process.platform === "win32" || process.platform === "darwin" || !!process.env.DISPLAY
export const displayReady = () => nativeDisplayReady()

function inject(cfg) {
  window.__R__ = null
  window.__E__ = null
  ;(async () => {
    try {
      await new Promise((res, rej) => {
        const s = document.createElement("script")
        s.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
        s.onload = () => res(); s.onerror = () => rej(new Error("sdk load failed"))
        document.head.appendChild(s)
      })
      window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }
      window.initAliyunCaptcha({
        SceneId: cfg.sceneId, mode: "popup", language: "zh-CN", showErrorTip: false,
        element: "#holder", button: "#btn",
        getInstance: (i) => { window.__I__ = i; if (i.startTracelessVerification) i.startTracelessVerification() },
        success: (p) => { window.__R__ = { ok: true, param: typeof p === "string" ? p : p?.captchaVerifyParam } },
        fail: (p) => { window.__R__ = { ok: false, why: p } },
        onError: (p) => { window.__E__ = p },
      })
    } catch (e) { window.__E__ = String(e) }
  })()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 在已连接的 DevTools 连接上打开 origin 并跑验证码。ws 是已经 open 的 WebSocket。
//
// Page.navigate 的应答要等导航提交才返回，走代理时可能很久，Chrome 156 上甚至一直不回，
// 而页面本身早已加载完。所以导航发出后不等应答，改为轮询 location；导航期间页面会话
// 可能几十秒不应答，探测用短超时，超时只代表「还没好」。
export async function solveOnPage(ws, cfg, { origin = "https://zcode.z.ai", timeoutMs = 45000, navTimeoutMs = 40000, probeMs = 2000, navPollMs = 1000, pollMs = 500 } = {}) {
  let id = 0, closed = false
  const pending = new Map()
  const call = (method, params, sessionId, ms, label) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("浏览器已关闭"))
    const mid = ++id
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(label)) }, ms)
    pending.set(mid, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
  })
  const send = (method, params = {}, sessionId) => call(method, params, sessionId, 10_000, `浏览器响应超时：${method}`)
  const evaluate = (expression, sessionId) => call("Runtime.evaluate", { expression, returnByValue: true }, sessionId, probeMs, "probe timeout")
  ws.onclose = () => { closed = true; for (const job of pending.values()) job.reject(new Error("浏览器已关闭")); pending.clear() }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  }
  const alive = () => { if (closed) throw new Error("浏览器已关闭") }

  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
    await send("Page.enable", {}, sessionId)
    await send("Runtime.enable", {}, sessionId)

    // 应答不作为成败依据；它若回来并带 errorText（代理不通、域名解析失败），用来给出明确原因。
    let navError = ""
    const navId = ++id
    pending.set(navId, { resolve: (v) => { if (v?.errorText) navError = v.errorText }, reject: () => {} })
    ws.send(JSON.stringify({ id: navId, method: "Page.navigate", params: { url: `${origin}/` }, sessionId }))

    let landed = false
    const navDeadline = Date.now() + navTimeoutMs
    while (!landed && Date.now() < navDeadline) {
      await sleep(navPollMs)
      alive()
      if (navError) throw new Error(`页面打开失败：${navError}`)
      try {
        const r = await evaluate("location.href + ' ' + document.readyState", sessionId)
        const [href = "", ready = ""] = String(r?.result?.value ?? "").split(" ")
        if (href.startsWith("chrome-error:")) throw Object.assign(new Error("页面打开失败：出口无法访问 " + origin), { fatal: true })
        landed = /^https?:/.test(href) && ready !== "loading" && ready !== ""
      } catch (e) { if (e?.fatal) throw e }
    }
    pending.delete(navId)
    alive()
    if (!landed) throw new Error(`页面打开超时 ${navTimeoutMs}ms：${origin}`)

    await send("Runtime.evaluate", { expression: `(${inject.toString()})(${JSON.stringify(cfg)})` }, sessionId)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      alive()
      let r
      try { r = await evaluate("JSON.stringify({r: window.__R__, e: window.__E__})", sessionId) } catch { continue }
      const v = r?.result?.value
      if (v) {
        const p = JSON.parse(v)
        if (p.r) {
          if (!p.r.ok) throw new Error("验证码未通过: " + JSON.stringify(p.r.why))
          return { param: p.r.param, region: cfg.region }
        }
        if (p.e) throw new Error("验证码出错: " + JSON.stringify(p.e))
      }
    }
    throw new Error("验证码超时 " + timeoutMs + "ms")
  } finally {
    try { ws.close() } catch {}
  }
}

// attestation 跑一次真实浏览器拿回执。proxy 传账号出口（socks5://127.0.0.1:port）。
export async function attestation(cfg, { proxy, timeoutMs = 45000, origin = "https://zcode.z.ai" } = {}) {
  const chrome = chromePath()
  if (!chrome) throw new Error("找不到 Chrome/Edge（ZCODE_CHROME_PATH 可指定）")
  if (!displayReady()) throw new Error("Linux 无桌面环境：请安装 Xvfb，或关闭自动领取")
  if (typeof WebSocket !== "function") throw new Error("自动领取需要 Bun 或 Node.js 22 及以上版本")

  let port = 8930 + Math.floor(Math.random() * 60)
  const html = `<!doctype html><meta charset="utf-8"><body><div id="holder"></div><button id="btn" style="display:none">v</button><script>(${inject.toString()})(${JSON.stringify(cfg)})</script></body>`
  const server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  // 端口被占就顺延重试（8930-8990 里挑一个）
  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener("error", onErr); reject(e) }
    server.once("error", onErr)
    server.listen(p, "127.0.0.1", () => { server.removeListener("error", onErr); resolve() })
  })
  let bound = false
  for (let i = 0; i < 5 && !bound; i++, port++) {
    try { await listen(port); bound = true } catch {}
  }
  if (!bound) throw new Error("本地回调端口被占（8930-8990），拿不到端口")
  const profile = mkdtempSync(join(tmpdir(), "zcaptcha-"))

  const args = [
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--window-position=-32000,-32000", "--window-size=1280,900", "--start-minimized",
    "--no-sandbox", "--disable-dev-shm-usage",
    ...(proxy ? [`--proxy-server=${proxy}`] : []),
    "about:blank",
  ]
  let stderr = "", spawnError = null, socketRef = null
  const bin = hasDisplay() ? chrome : "/usr/bin/xvfb-run"
  const argv = hasDisplay() ? args : ["-a", "-s", "-screen 0 1280x900x24", chrome, ...args]
  // detached + 进程组 kill：xvfb-run 死了它拉起的 Xvfb 还活着，会撑住事件循环
  const child = spawn(bin, argv, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true })
  child.on("error", (error) => { spawnError = error })
  child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-16000) })

  const cleanup = () => {
    try { socketRef?.close() } catch {}
    killProcessTree(child)
    try { server.close() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const end = Date.now() + 30000
      const tick = () => {
        if (spawnError) return reject(new Error(`浏览器启动失败：${spawnError.message}`))
        if (Date.now() >= end || child.exitCode !== null) return reject(new Error("浏览器没有提供 DevTools 端口，请检查浏览器安装及运行权限"))
        try {
          const txt = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")
          if (txt.length >= 2 && txt[1]) resolve(`ws://127.0.0.1:${txt[0].trim()}${txt[1].trim()}`)
          else setTimeout(tick, 150)
        } catch { setTimeout(tick, 150) }
      }
      tick()
    })

    const ws = socketRef = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("浏览器调试连接超时")), 10_000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error("浏览器调试连接失败")) }
    })
    return await solveOnPage(ws, cfg, { origin, timeoutMs })
  } finally {
    cleanup()
  }
}
