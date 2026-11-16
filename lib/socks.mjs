// Minimal SOCKS5-tunnelled HTTPS fetch — works under bun and node, no deps.
// magpie 的账号出口是 socks5://127.0.0.1:<port>（mihomo listener），
// bun 的 fetch 原生只认 http(s) 代理，所以这里自己拨 SOCKS5 隧道再跑 TLS。
import net from "node:net"
import tls from "node:tls"
import http from "node:http"
import { httpProxyFetch } from "./http-proxy.mjs"

export function socksConnect(proxyUrl, host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(proxyUrl) } catch { return reject(new Error("无效的 SOCKS5 地址")) }
    if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") return reject(new Error("需要 SOCKS5 代理"))
    const name = Buffer.from(host.replace(/^\[|\]$/g, ""), "utf8")
    if (!name.length || name.length > 255 || !Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error("无效的 SOCKS5 目标"))
    let user, password
    try { user = Buffer.from(decodeURIComponent(u.username)); password = Buffer.from(decodeURIComponent(u.password)) }
    catch { return reject(new Error("无效的 SOCKS5 凭据编码")) }
    if (user.length > 255 || password.length > 255) return reject(new Error("SOCKS5 凭据过长"))
    const authenticated = !!(user.length || password.length)
    const pHost = u.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1"
    const pPort = Number(u.port) || 1080
    const sock = net.connect({ host: pHost, port: pPort })
    let stage = "greeting", buffer = Buffer.alloc(0), done = false
    const timer = setTimeout(() => fail(new Error(`SOCKS5 连接超时（${stage}）`)), timeoutMs)
    const cleanup = () => { clearTimeout(timer); sock.removeListener("data", onData); sock.removeListener("error", fail); sock.removeListener("end", onEnd); sock.removeListener("close", onEnd) }
    const fail = (error) => { if (done) return; done = true; cleanup(); sock.destroy(); reject(error) }
    const onEnd = () => fail(new Error("SOCKS5 握手中断"))
    const connect = () => {
      stage = "connect"
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]))
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 65536) return fail(new Error("SOCKS5 握手响应过大"))
      if (stage === "greeting") {
        if (buffer.length < 2) return
        const method = buffer[1]
        if (buffer[0] !== 5 || (method !== 0 && !(method === 2 && authenticated))) return fail(new Error("SOCKS5 认证方式被拒绝"))
        buffer = buffer.subarray(2)
        if (method === 2) {
          stage = "auth"
          sock.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
        } else connect()
      }
      if (stage === "auth") {
        if (buffer.length < 2) return
        if (buffer[0] !== 1 || buffer[1] !== 0) return fail(new Error("SOCKS5 认证失败"))
        buffer = buffer.subarray(2); connect()
      }
      if (stage === "connect") {
        if (buffer.length < 4) return
        if (buffer[0] !== 5 || buffer[1] !== 0) return fail(new Error(`SOCKS5 连接被拒绝（${buffer[1]}）`))
        const type = buffer[3]
        if (type === 3 && buffer.length < 5) return
        const length = type === 1 ? 10 : type === 4 ? 22 : type === 3 ? 7 + buffer[4] : 0
        if (!length) return fail(new Error("SOCKS5 返回了未知地址类型"))
        if (buffer.length < length) return
        done = true; cleanup(); sock.pause()
        if (buffer.length > length) sock.unshift(buffer.subarray(length))
        resolve(sock)
      }
    }
    sock.once("error", fail).once("end", onEnd).once("close", onEnd).on("data", onData)
    sock.once("connect", () => sock.write(Buffer.from(authenticated ? [5, 2, 0, 2] : [5, 1, 0])))
  })
}

const isIpv4 = (s) => net.isIPv4(String(s))

// proxiedFetch: GET/POST through socks5 / http proxy, or direct.
// Returns {status, headers, text, ms}. body: string | undefined.
export async function proxiedFetch(url, { proxy, method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  const t0 = performance.now()
  let tlsMs = null
  const done = (r) => ({ ...r, ms: performance.now() - t0, tlsMs })
  const u = new URL(url)
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("仅支持 HTTP(S) 目标")
  const via = proxy && /^(socks5h?|https?):/.test(proxy) ? proxy : ""
  if (proxy && !via) throw new Error("不支持的代理协议，请使用 SOCKS5 或 HTTP(S)")
  if (!via) {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
    return done({ status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() })
  }
  if (via.startsWith("http")) {
    return done(await httpProxyFetch(url, { proxy: via, method, headers, body, timeoutMs }))
  }
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80)
  const sock = await socksConnect(via, u.hostname, port, timeoutMs)
  let transport = sock
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = () => transport
  const plain = (reqOpts) => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => req.destroy(new Error("代理请求超时")), Math.max(1, timeoutMs - (performance.now() - t0)))
    const fin = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const req = http.request(reqOpts, (res) => {
      const chunks = []; let bytes = 0
      res.on("data", (chunk) => {
        bytes += chunk.length
        if (bytes > 3_000_000) return req.destroy(new Error("代理响应超过 3 MB"))
        chunks.push(chunk)
      })
      res.on("end", () => fin(null, done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") })))
      res.on("aborted", () => fin(new Error("代理响应已中断")))
      res.on("error", (error) => fin(error))
    })
    req.on("error", (error) => fin(error))
    req.end(body)
  })
  try {
    const requestHeaders = Object.fromEntries(new Headers(headers))
    delete requestHeaders["proxy-authorization"]
    const reqOpts = {
      hostname: u.hostname.replace(/^\[|\]$/g, ""), port, agent,
      path: u.pathname + u.search, method,
      headers: { ...requestHeaders, host: u.host, ...(body !== undefined && !requestHeaders["content-length"] ? { "content-length": Buffer.byteLength(body) } : {}) },
    }
    if (u.protocol === "https:") {
      const host = u.hostname.replace(/^\[|\]$/g, "")
      transport = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
      transport.once("secureConnect", () => { tlsMs = performance.now() - t0 })
    }
    sock.resume()
    return await plain(reqOpts)
  } finally { agent.destroy(); transport.destroy(); sock.destroy() }
}

export { isIpv4 }
