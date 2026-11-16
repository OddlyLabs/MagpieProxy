import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, connect } from "node:net"
import { createServer as httpServer } from "node:http"
import { createServer as httpsServer } from "node:https"
import { readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { proxiedFetch, socksConnect } from "../lib/socks.mjs"

const run = promisify(execFile)
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
async function proxyFor(t, originPort, { auth = false } = {}) {
  const sockets = new Set(), seen = []
  const track = (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket }
  const server = createServer((client) => {
    track(client)
    let buffer = Buffer.alloc(0), stage = 0
    const send = (bytes) => { client.write(bytes.subarray(0, 1)); setTimeout(() => { if (!client.destroyed) client.write(bytes.subarray(1)) }, 5) }
    const data = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        buffer = buffer.subarray(2 + buffer[1]); stage = auth ? 1 : 2
        send(Buffer.from([5, auth ? 2 : 0]))
      }
      if (stage === 1) {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
        const end = 3 + buffer[1] + buffer[2 + buffer[1]]
        if (buffer.length < end) return
        seen.push({ user: buffer.subarray(2, 2 + buffer[1]).toString(), password: buffer.subarray(3 + buffer[1], end).toString() })
        buffer = buffer.subarray(end); stage = 2; send(Buffer.from([1, 0]))
      }
      if (stage === 2) {
        if (buffer.length < 5 || buffer.length < 7 + buffer[4]) return
        seen.push({ host: buffer.subarray(5, 5 + buffer[4]).toString(), port: buffer.readUInt16BE(5 + buffer[4]) })
        stage = 3; client.removeListener("data", data)
        const upstream = track(connect(originPort, "127.0.0.1", () => {
          send(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          client.pipe(upstream); upstream.pipe(client)
        }))
        client.on("close", () => upstream.destroy()); upstream.on("error", () => client.destroy())
      }
    }
    client.on("data", data)
  })
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  return { port: await listen(server), seen }
}

test("fragmented SOCKS5 handshakes and authentication still tunnel every HTTP request", async (t) => {
  const origin = httpServer((req, res) => { assert.equal(req.headers.host, "unresolvable.invalid"); res.end("through-socks") })
  t.after(() => { origin.closeAllConnections(); origin.close() })
  const proxy = await proxyFor(t, await listen(origin), { auth: true })
  const result = await proxiedFetch("http://unresolvable.invalid/test", { proxy: `socks5://demo:p%40ss@127.0.0.1:${proxy.port}`, timeoutMs: 3000 })
  assert.equal(result.status, 200); assert.equal(result.text, "through-socks"); assert.equal(result.tlsMs, null)
  assert.deepEqual(proxy.seen, [{ user: "demo", password: "p@ss" }, { host: "unresolvable.invalid", port: 80 }])
})

test("SOCKS5 HTTPS validates certificates and returns actual TLS timing", { timeout: 15000 }, async (t) => {
  let requests = 0
  const origin = httpsServer({ cert: readFileSync(new URL("fixtures/proxy-cert.pem", import.meta.url)), key: readFileSync(new URL("fixtures/proxy-key.pem", import.meta.url)) }, (_req, res) => { requests++; res.writeHead(401); res.end("authenticated transport") })
  t.after(() => { origin.closeAllConnections(); origin.close() })
  const proxy = await proxyFor(t, await listen(origin))
  const url = "https://unresolvable.invalid/probe", options = { proxy: `socks5://127.0.0.1:${proxy.port}`, timeoutMs: 3000, method: "POST", body: "{}" }
  const script = `import { proxiedFetch } from ${JSON.stringify(new URL("../lib/socks.mjs", import.meta.url).href)}; console.log(JSON.stringify(await proxiedFetch(${JSON.stringify(url)}, ${JSON.stringify(options)})))`
  const result = await run(process.env.TEST_RUNTIME || process.execPath, ["--input-type=module", "-e", script], { timeout: 7000, env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL("fixtures/proxy-cert.pem", import.meta.url)) } })
  const response = JSON.parse(result.stdout)
  assert.equal(response.status, 401); assert.ok(response.tlsMs > 0); assert.ok(response.ms >= response.tlsMs)
  await assert.rejects(proxiedFetch(url, options), /certificate|self.signed|CERT/i)
  assert.equal(requests, 1)
})

test("a truncated SOCKS5 handshake rejects promptly instead of leaving an open task", async (t) => {
  const server = createServer((socket) => { socket.on("error", () => {}); socket.once("data", () => socket.end(Buffer.from([5]))) })
  t.after(() => server.close())
  const port = await listen(server), start = Date.now()
  await assert.rejects(socksConnect(`socks5://127.0.0.1:${port}`, "example.invalid", 443, 1000), /中断/)
  assert.ok(Date.now() - start < 1000)
})
