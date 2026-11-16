// Explicit HTTP proxying for Node and Bun. Never fall back to a direct request.
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import { isIP } from "node:net"

const hostname = (url) => url.hostname.replace(/^\[|\]$/g, "")
const proxyHeaders = (url) => url.username || url.password
  ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}` } : {}

function responseBody(client, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false, timer
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const req = client.request(options, (res) => {
      const chunks = []; let bytes = 0
      res.on("data", (chunk) => {
        bytes += chunk.length
        if (bytes > 3_000_000) { req.destroy(new Error("代理响应超过 3 MB")); return }
        chunks.push(chunk)
      })
      res.on("end", () => finish(null, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }))
      res.on("aborted", () => finish(new Error("代理响应已中断")))
      res.on("error", (error) => finish(error))
    })
    timer = setTimeout(() => req.destroy(new Error("代理请求超时")), timeoutMs)
    req.on("error", (error) => finish(error))
    req.end(body)
  })
}
function connectTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || 443}`
    const client = proxy.protocol === "https:" ? https : http
    const req = client.request({ hostname: hostname(proxy), port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: authority, headers: { host: authority, ...proxyHeaders(proxy) }, agent: false })
    const timer = setTimeout(() => req.destroy(new Error("代理隧道连接超时")), timeoutMs)
    req.on("error", (error) => { clearTimeout(timer); reject(error) })
    req.on("connect", (response, socket, head) => {
      clearTimeout(timer)
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`HTTP proxy CONNECT refused (${response.statusCode})`)); return }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.end()
  })
}
export async function httpProxyFetch(url, { proxy, method = "GET", headers = {}, body, timeoutMs = 20000 }) {
  const target = new URL(url), via = new URL(proxy), deadline = Date.now() + timeoutMs
  if (!["http:", "https:"].includes(target.protocol) || !["http:", "https:"].includes(via.protocol)) throw new Error("仅支持 HTTP(S) 目标和代理")
  const requestHeaders = Object.fromEntries(new Headers(headers))
  delete requestHeaders["proxy-authorization"]
  if (body !== undefined && !requestHeaders["content-length"]) requestHeaders["content-length"] = Buffer.byteLength(body)
  requestHeaders.host = target.host
  if (target.protocol === "http:") {
    return responseBody(via.protocol === "https:" ? https : http, {
      hostname: hostname(via), port: via.port || (via.protocol === "https:" ? 443 : 80),
      path: target.href, method, headers: { ...requestHeaders, ...proxyHeaders(via) }, agent: false,
    }, body, timeoutMs)
  }
  const socket = await connectTunnel(via, target, timeoutMs)
  const secure = tls.connect({ socket, servername: isIP(hostname(target)) ? undefined : hostname(target), rejectUnauthorized: true })
  // A dedicated agent is essential: the global agent would open a direct socket.
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = () => secure
  try {
    return await responseBody(http, { hostname: hostname(target), port: target.port || 443, path: target.pathname + target.search, method, headers: requestHeaders, agent }, body, Math.max(1, deadline - Date.now()))
  } finally { agent.destroy(); secure.destroy(); socket.destroy() }
}
