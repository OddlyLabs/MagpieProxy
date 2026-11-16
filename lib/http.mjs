export class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode }
}

export function readJsonBody(req, { maxBytes = 1_048_576, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false
    const chunks = []
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.removeListener("data", onData)
      req.removeListener("end", onEnd)
      req.removeListener("aborted", onAbort)
      req.removeListener("error", onError)
      if (error) { req.resume(); reject(error) } else resolve(value)
    }
    const onData = (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > maxBytes) return finish(new HttpError(413, "请求内容过大（最多 1 MB）"))
      chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => {
      let value
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }
      catch { return finish(new HttpError(400, "请求不是有效的 JSON")) }
      if (!value || typeof value !== "object" || Array.isArray(value)) return finish(new HttpError(400, "请求内容必须是 JSON 对象"))
      if (value.id !== undefined && (typeof value.id !== "string" || !value.id || value.id.length > 160)) return finish(new HttpError(400, "请求 ID 必须是 1–160 字符的字符串"))
      finish(null, value)
    }
    const onAbort = () => finish(new HttpError(400, "请求已中断"))
    const onError = () => finish(new HttpError(400, "读取请求失败"))
    const timer = setTimeout(() => finish(new HttpError(408, "读取请求超时")), timeoutMs)
    timer.unref?.()
    req.on("data", onData).once("end", onEnd).once("aborted", onAbort).once("error", onError)
    if (Number(req.headers?.["content-length"]) > maxBytes) finish(new HttpError(413, "请求内容过大（最多 1 MB）"))
  })
}

export function sendJson(res, code, value) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
  res.end(JSON.stringify(value))
}

export function assertLocalRequest(req, port, { uiToken = "" } = {}) {
  if (req.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) throw new HttpError(403, "仅限本机访问")
  let host
  try { host = new URL(`http://${req.headers.host || `127.0.0.1:${port}`}`) }
  catch { throw new HttpError(400, "无效的 Host") }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) throw new HttpError(403, "仅允许本机 Host")
  const origin = req.headers.origin
  const trustedFrame = origin === "null" && uiToken && req.headers["x-egress-token"] === uiToken
  if (origin && origin !== host.origin && !trustedFrame) throw new HttpError(403, "不接受跨站请求")
}
