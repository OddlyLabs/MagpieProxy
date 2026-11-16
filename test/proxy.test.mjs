import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect } from "node:net"
import { readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { proxiedFetch, isIpv4 } from "../lib/socks.mjs"

const run = promisify(execFile)
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

test("Node HTTP requests actually use the configured authenticated proxy", async (t) => {
  const requests = []
  const proxy = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk })
    req.on("end", () => { requests.push({ url: req.url, host: req.headers.host, auth: req.headers["proxy-authorization"], body }); res.end('{"via":"proxy"}') })
  })
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const result = await proxiedFetch("http://unresolvable.invalid/endpoint?test=1", { proxy: `http://demo:p%40ss@127.0.0.1:${proxy.address().port}`, method: "POST", body: '{"sample":true}', timeoutMs: 2000 })
  assert.equal(result.status, 200); assert.equal(result.text, '{"via":"proxy"}')
  assert.deepEqual(requests, [{ url: "http://unresolvable.invalid/endpoint?test=1", host: "unresolvable.invalid", auth: "Basic " + Buffer.from("demo:p@ss").toString("base64"), body: '{"sample":true}' }])
})
test("refused HTTPS CONNECT and unsupported proxies never fall back to direct requests", async (t) => {
  let connections = 0
  const proxy = createServer()
  proxy.on("connect", (req, socket) => { connections++; assert.equal(req.url, "unresolvable.invalid:443"); socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n") })
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  t.after(() => proxy.close())
  await assert.rejects(proxiedFetch("https://unresolvable.invalid/test", { proxy: `http://127.0.0.1:${proxy.address().port}`, timeoutMs: 2000 }), /CONNECT refused \(407\)/)
  assert.equal(connections, 1)
  await assert.rejects(proxiedFetch("https://unresolvable.invalid/test", { proxy: "ftp://127.0.0.1:21" }), /代理协议/)
})
test("IPv4 validation rejects addresses outside the legal octet range", () => {
  assert.equal(isIpv4("198.51.100.1"), true); assert.equal(isIpv4("999.1.2.3"), false); assert.equal(isIpv4("1.2.3.4 trailing"), false)
})

test("HTTPS travels through an authenticated CONNECT tunnel and verifies its certificate", { timeout: 15_000 }, async (t) => {
  const requests = [], tunnels = [], sockets = new Set()
  const origin = createHttpsServer({ key: readFileSync(new URL("fixtures/proxy-key.pem", import.meta.url)), cert: readFileSync(new URL("fixtures/proxy-cert.pem", import.meta.url)) }, (req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk })
    req.on("end", () => { requests.push({ url: req.url, host: req.headers.host, auth: req.headers["proxy-authorization"], body }); res.end('{"secure":true}') })
  })
  const proxy = createServer()
  const track = (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); return socket }
  proxy.on("connection", track)
  t.after(() => { for (const socket of sockets) socket.destroy(); origin.closeAllConnections(); origin.close(); proxy.close() })
  const originPort = await listen(origin)
  proxy.on("connect", (req, socket, head) => {
    tunnels.push({ target: req.url, auth: req.headers["proxy-authorization"] })
    const upstream = track(connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    }))
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
  })
  const proxyUrl = `http://demo:p%40ss@127.0.0.1:${await listen(proxy)}`
  const url = "https://unresolvable.invalid:9443/secure?test=1"
  const code = `import { proxiedFetch } from ${JSON.stringify(new URL("../lib/socks.mjs", import.meta.url).href)};
    const result = await proxiedFetch(${JSON.stringify(url)}, ${JSON.stringify({ proxy: proxyUrl, method: "POST", headers: { "proxy-authorization": "must-not-reach-origin" }, body: '{"secure":true}', timeoutMs: 4000 })});
    process.stdout.write(JSON.stringify(result));`
  const result = await run(process.execPath, ["--input-type=module", "-e", code], { timeout: 8000, env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL("fixtures/proxy-cert.pem", import.meta.url)) } })
  assert.equal(JSON.parse(result.stdout).status, 200)
  assert.equal(JSON.parse(result.stdout).text, '{"secure":true}')
  assert.deepEqual(requests, [{ url: "/secure?test=1", host: "unresolvable.invalid:9443", auth: undefined, body: '{"secure":true}' }])
  assert.deepEqual(tunnels, [{ target: "unresolvable.invalid:9443", auth: "Basic " + Buffer.from("demo:p@ss").toString("base64") }])
  await assert.rejects(proxiedFetch(url, { proxy: proxyUrl, timeoutMs: 3000 }), /certificate|self.signed|CERT/i)
  assert.equal(requests.length, 1, "untrusted certificates must be rejected before sending the HTTP request")
})
