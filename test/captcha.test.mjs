// solveOnPage 的 DevTools 对话：用假的 WebSocket 代替浏览器，不启动 Chrome。
import { solveOnPage } from "../lib/captcha.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"

const cfg = { region: "sgp", prefix: "p", sceneId: "s" }
const fast = { origin: "https://example.test", probeMs: 40, navPollMs: 5, pollMs: 5, navTimeoutMs: 1500, timeoutMs: 1500 }

// answer(消息, 这是第几次 Runtime.evaluate) 返回 undefined 表示不应答；返回 { error } 表示报错
function fakeBrowser(answer) {
  const ws = { sent: [], closed: false }
  let evaluations = 0
  ws.send = (text) => {
    const m = JSON.parse(text)
    ws.sent.push(m)
    const result = answer(m, m.method === "Runtime.evaluate" ? ++evaluations : 0)
    if (result === undefined) return
    setTimeout(() => ws.onmessage?.({ data: JSON.stringify(result.error ? { id: m.id, error: result.error } : { id: m.id, result }) }), 1)
  }
  ws.close = () => { if (!ws.closed) { ws.closed = true; ws.onclose?.() } }
  return ws
}

const setup = (m) => {
  if (m.method === "Target.createTarget") return { targetId: "t" }
  if (m.method === "Target.attachToTarget") return { sessionId: "s" }
  if (m.method === "Page.enable" || m.method === "Runtime.enable") return {}
}
const value = (v) => ({ result: { value: v } })
const isInject = (m) => m.params.expression.includes("AliyunCaptcha.js")
const isResult = (m) => m.params.expression.startsWith("JSON.stringify")
const solved = JSON.stringify({ r: { ok: true, param: "PARAM" }, e: null })

test("Page.navigate 一直不应答、页面会话一度无响应时仍能拿到回执", async () => {
  let resultPolls = 0
  const ws = fakeBrowser((m, n) => {
    if (m.method === "Page.navigate") return undefined
    if (m.method !== "Runtime.evaluate") return setup(m)
    if (isInject(m)) return {}
    if (isResult(m)) return ++resultPolls === 1 ? undefined : resultPolls < 4 ? value(JSON.stringify({ r: null, e: null })) : value(solved)
    if (n <= 2) return undefined                      // 导航期间会话卡住
    if (n === 3) return value("about:blank complete") // 还没离开空白页
    if (n === 4) return value("https://example.test/cn loading")
    return value("https://example.test/cn complete")
  })
  assert.deepEqual(await solveOnPage(ws, cfg, fast), { param: "PARAM", region: "sgp" })
  const methods = ws.sent.map((m) => m.method)
  assert.equal(methods.filter((m) => m === "Page.navigate").length, 1)
  assert.equal(ws.sent.find((m) => m.method === "Page.navigate").params.url, "https://example.test/")
  const injectAt = ws.sent.findIndex((m) => m.method === "Runtime.evaluate" && isInject(m))
  assert.ok(injectAt > methods.indexOf("Page.navigate"), "页面落位后才注入")
  assert.equal(ws.closed, true)
})

test("页面始终没有落位时报页面打开超时，而不是 Page.navigate 超时", async () => {
  const ws = fakeBrowser((m) => m.method === "Runtime.evaluate" ? value("about:blank complete") : setup(m))
  await assert.rejects(solveOnPage(ws, cfg, { ...fast, navTimeoutMs: 120 }), /页面打开超时 120ms/)
  assert.equal(ws.sent.some((m) => m.method === "Runtime.evaluate" && isInject(m)), false)
  assert.equal(ws.closed, true)
})

test("导航应答带 errorText 时立即报出原因", async () => {
  const ws = fakeBrowser((m) => m.method === "Page.navigate" ? { frameId: "f", errorText: "net::ERR_PROXY_CONNECTION_FAILED" }
    : m.method === "Runtime.evaluate" ? value("about:blank complete") : setup(m))
  await assert.rejects(solveOnPage(ws, cfg, fast), /页面打开失败：net::ERR_PROXY_CONNECTION_FAILED/)
})

test("落在浏览器错误页时不再等待", async () => {
  const ws = fakeBrowser((m) => m.method === "Page.navigate" ? undefined
    : m.method === "Runtime.evaluate" ? value("chrome-error://chromewebdata/ complete") : setup(m))
  await assert.rejects(solveOnPage(ws, cfg, fast), /页面打开失败：出口无法访问/)
})

test("验证码未通过和出错照常上报", async () => {
  const page = (payload) => fakeBrowser((m) => m.method === "Page.navigate" ? { frameId: "f" }
    : m.method !== "Runtime.evaluate" ? setup(m) : isInject(m) ? {} : isResult(m) ? value(JSON.stringify(payload)) : value("https://example.test/ complete"))
  await assert.rejects(solveOnPage(page({ r: { ok: false, why: "F001" }, e: null }), cfg, fast), /验证码未通过: "F001"/)
  await assert.rejects(solveOnPage(page({ r: null, e: "sdk load failed" }), cfg, fast), /验证码出错: "sdk load failed"/)
})

test("浏览器中途关闭时立即结束", async () => {
  const ws = fakeBrowser((m) => m.method === "Page.navigate" ? (setTimeout(() => ws.close(), 20), undefined)
    : m.method === "Runtime.evaluate" ? undefined : setup(m))
  await assert.rejects(solveOnPage(ws, cfg, fast), /浏览器已关闭/)
})
